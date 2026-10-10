import pg from 'pg';
import { CFG } from './config.js';
import { VISITOR_CODES } from './codes.js';

let pool = null;
let lastWarn = 0;
const warn = (e) => {
  if (Date.now() - lastWarn > 10000) { lastWarn = Date.now(); console.warn('[postgres]', e?.message || e); }
};

// Append-only migrations. Never edit an applied one; add a new entry instead.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    telegram_id BIGINT PRIMARY KEY,
    username    TEXT,
    first_name  TEXT,
    first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    requests    INTEGER NOT NULL DEFAULT 0,
    banned      BOOLEAN NOT NULL DEFAULT false
  );
  CREATE TABLE downloads (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(telegram_id),
    url         TEXT NOT NULL,
    url_key     TEXT NOT NULL,
    host        TEXT NOT NULL,
    status      TEXT NOT NULL,
    error_code  TEXT,
    mode        TEXT,
    cached      BOOLEAN NOT NULL DEFAULT false,
    files       INTEGER,
    zip_bytes   BIGINT,
    duration_ms INTEGER,
    tg_file_id  TEXT,
    file_name   TEXT,
    caption     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX downloads_user_idx ON downloads (user_id, created_at DESC);
  CREATE INDEX downloads_fresh_idx ON downloads (url_key, created_at DESC)
    WHERE status = 'ok' AND cached = false AND tg_file_id IS NOT NULL;
  CREATE INDEX downloads_created_idx ON downloads (created_at);
  `,
  `
  ALTER TABLE downloads ADD COLUMN title TEXT, ADD COLUMN timings JSONB;
  `,
  // v1.6: per-user language and retention, anonymous owner for cleared history, admin domain block list
  `
  ALTER TABLE users ADD COLUMN retention_days INT, ADD COLUMN lang TEXT;
  INSERT INTO users (telegram_id, first_name) VALUES (0, 'anonymous') ON CONFLICT DO NOTHING;
  CREATE INDEX downloads_user_key_idx ON downloads (user_id, url_key);
  CREATE TABLE blocked_domains (
    domain     TEXT PRIMARY KEY,
    added_by   BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  `,
];

export const enabled = () => pool !== null;

async function q(text, params = []) {
  if (!pool) return null;
  try { return (await pool.query(text, params)).rows; }
  catch (e) { warn(e); return null; }
}

async function migrate() {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727274)'); // two deploys must not migrate at once
    await c.query('CREATE TABLE IF NOT EXISTS schema_version (version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const { rows } = await c.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version');
    for (let i = Number(rows[0].v); i < MIGRATIONS.length; i++) {
      await c.query('BEGIN');
      try {
        await c.query(MIGRATIONS[i]);
        await c.query('INSERT INTO schema_version (version) VALUES ($1)', [i + 1]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    c.release();
  }
}

export async function init() {
  if (!CFG.databaseUrl) { console.log('Postgres: not configured (history/stats disabled)'); return false; }
  const p = new pg.Pool({
    connectionString: CFG.databaseUrl,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 8000,
    ssl: CFG.pgSsl ? { rejectUnauthorized: false } : undefined,
  });
  p.on('error', warn);
  try {
    pool = p;
    await migrate();
    console.log('Postgres: connected, schema up to date');
    return true;
  } catch (e) {
    console.error('Postgres unavailable, continuing without it:', e.message);
    pool = null;
    await p.end().catch(() => {});
    return false;
  }
}

// round-trip check for /ping
export async function ping() { return (await q('SELECT 1 AS ok'))?.[0]?.ok === 1; }

export async function shutdown() { if (pool) await pool.end().catch(() => {}); }

export async function touchUser(from) {
  const r = await q(
    `INSERT INTO users (telegram_id, username, first_name, requests) VALUES ($1, $2, $3, 1)
     ON CONFLICT (telegram_id) DO UPDATE
       SET username = EXCLUDED.username, first_name = EXCLUDED.first_name,
           last_seen = now(), requests = users.requests + 1
     RETURNING banned, lang`,
    [from.id, from.username || null, from.first_name || null]
  );
  return r?.[0] || null;
}

export async function findFresh(urlKey, ttlSec) {
  const r = await q(
    `SELECT tg_file_id, file_name, caption, title, host, mode, files, zip_bytes, url_key, created_at
       FROM downloads
      WHERE url_key = $1 AND status = 'ok' AND cached = false AND tg_file_id IS NOT NULL
        AND created_at > now() - make_interval(secs => $2::int)
      ORDER BY created_at DESC LIMIT 1`,
    [urlKey, Math.floor(ttlSec)]
  );
  return r?.[0] || null;
}

export async function record(d) {
  await q(
    `INSERT INTO downloads
       (user_id, url, url_key, host, status, error_code, mode, cached, files, zip_bytes, duration_ms, tg_file_id, file_name, caption, title, timings)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
    [d.userId, d.url, d.urlKey, d.host, d.status, d.errorCode || null, d.mode || null, !!d.cached,
     d.files ?? null, d.zipBytes ?? null, d.durationMs ?? null, d.fileId || null, d.fileName || null, d.caption || null,
     d.title || null, d.timings ? JSON.stringify(d.timings) : null]
  );
}

export async function history(userId, limit = 8) {
  return (await q(
    `SELECT * FROM (
       SELECT DISTINCT ON (url_key) id, host, title, tg_file_id, created_at
         FROM downloads
        WHERE user_id = $1 AND status = 'ok' AND tg_file_id IS NOT NULL
        ORDER BY url_key, created_at DESC
     ) t ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  )) || [];
}

export async function historyCount(userId) {
  const r = await q(`SELECT count(DISTINCT url_key) AS n FROM downloads WHERE user_id = $1 AND status = 'ok' AND tg_file_id IS NOT NULL`, [userId]);
  return Number(r?.[0]?.n || 0);
}

// "Removing" history = unlinking it from the person. Rows that only recorded a cached resend or a failure are deleted.
// A real build stays, owned by nobody (user 0), because its Telegram file is the shared cache other users get instantly;
// it holds no link to the person who asked.
async function unlink(cond, params) {
  await q(`DELETE FROM downloads WHERE ${cond} AND (cached = true OR status <> 'ok' OR tg_file_id IS NULL)`, params);
  const r = await q(`UPDATE downloads SET user_id = 0 WHERE ${cond} RETURNING id`, params);
  return r?.length ?? 0;
}

// one entry (every row of that site for this user)
export async function removeHistoryItem(id, userId) {
  const r = await q('SELECT url_key FROM downloads WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!r?.length) return false;
  await unlink('user_id = $1 AND url_key = $2', [userId, r[0].url_key]);
  return true;
}

export const clearHistory = (userId) => unlink('user_id = $1', [userId]);

// "Delete all my data": history unlinked, name and settings wiped. The users row stays (a ban must survive it).
export async function purgeUser(userId) {
  await unlink('user_id = $1', [userId]);
  await q('UPDATE users SET username = NULL, first_name = NULL, retention_days = NULL, lang = NULL WHERE telegram_id = $1', [userId]);
  return true;
}

export async function getRetention(userId) {
  const r = await q('SELECT retention_days FROM users WHERE telegram_id = $1', [userId]);
  return r?.[0] ? r[0].retention_days : null;
}
// days: null = default, 0 = never delete automatically
export async function setRetention(userId, days) {
  const r = await q('UPDATE users SET retention_days = $2 WHERE telegram_id = $1 RETURNING telegram_id', [userId, days]);
  return !!r?.length;
}

export async function getLang(userId) {
  const r = await q('SELECT lang FROM users WHERE telegram_id = $1', [userId]);
  return r?.[0]?.lang || null;
}
export async function setLang(userId, lang) { await q('UPDATE users SET lang = $2 WHERE telegram_id = $1', [userId, lang]); }

// ---------- admin domain block list ----------
export async function blockedDomains() {
  return ((await q('SELECT domain FROM blocked_domains ORDER BY domain')) || []).map((r) => r.domain);
}
export async function blockDomain(domain, by) {
  const r = await q('INSERT INTO blocked_domains (domain, added_by) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING domain', [domain, by]);
  return r !== null;
}
export async function unblockDomain(domain) {
  const r = await q('DELETE FROM blocked_domains WHERE domain = $1 RETURNING domain', [domain]);
  return !!r?.length;
}

export async function isBanned(id) {
  const r = await q('SELECT banned FROM users WHERE telegram_id = $1', [id]);
  return !!r?.[0]?.banned;
}

export async function getDownload(id, userId) {
  const r = await q('SELECT * FROM downloads WHERE id = $1 AND user_id = $2', [id, userId]);
  return r?.[0] || null;
}

export async function urlForKey(urlKey) {
  const r = await q('SELECT url FROM downloads WHERE url_key = $1 ORDER BY id DESC LIMIT 1', [urlKey]);
  return r?.[0]?.url || null;
}

// Telegram no longer knows this file_id -> stop offering it
export async function invalidateFile(fileId) {
  await q('UPDATE downloads SET tg_file_id = NULL WHERE tg_file_id = $1', [fileId]);
}

export async function setBanned(id, banned) {
  const r = await q('UPDATE users SET banned = $2 WHERE telegram_id = $1 RETURNING telegram_id', [id, banned]);
  return !!r?.length;
}

// Median and 95th percentile instead of averages: one slow outlier no longer hides how a typical job goes.
const PHASES = ['fetch', 'browser', 'map', 'crawl', 'assets', 'build', 'zip', 'upload'];
export async function stats() {
  const main = await q(
    `SELECT (SELECT count(*) FROM users WHERE telegram_id <> 0) AS users,
            count(*) AS total,
            count(*) FILTER (WHERE status = 'ok') AS ok,
            count(*) FILTER (WHERE cached) AS cached,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS last24h
       FROM downloads`
  );
  if (!main) return null;
  const week = await q(
    `SELECT count(*) FILTER (WHERE status = 'ok') AS ok7,
            count(*) FILTER (WHERE status = 'failed') AS failed7,
            count(*) FILTER (WHERE status = 'failed' AND COALESCE(error_code, 'unknown') <> ALL($1::text[])) AS ours7,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE status = 'ok' AND NOT cached) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE status = 'ok' AND NOT cached) AS p95
       FROM downloads WHERE created_at > now() - interval '7 days'`,
    [[...VISITOR_CODES]]
  );
  const hosts = await q(`SELECT host, count(*) AS c FROM downloads WHERE created_at > now() - interval '7 days' GROUP BY host ORDER BY c DESC LIMIT 5`);
  const errors = await q(`SELECT COALESCE(error_code,'unknown') AS code, count(*) AS c FROM downloads WHERE status = 'failed' AND created_at > now() - interval '7 days' GROUP BY 1 ORDER BY c DESC LIMIT 5`);
  const pc = (p, n) => `percentile_cont(${p}) WITHIN GROUP (ORDER BY (timings->>'${n}')::numeric) FILTER (WHERE timings ? '${n}')`;
  const phaseRow = await q(
    `SELECT ${PHASES.map((n) => `${pc(0.5, n)} AS ${n}_p50, ${pc(0.95, n)} AS ${n}_p95`).join(',\n            ')},
            count(*) FILTER (WHERE mode LIKE '%browser%') AS browser_jobs,
            count(*) AS jobs
       FROM downloads
      WHERE status = 'ok' AND NOT cached AND timings IS NOT NULL AND created_at > now() - interval '7 days'`
  );
  const r = phaseRow?.[0];
  const phases = r
    ? { jobs: r.jobs, browser_jobs: r.browser_jobs, rows: PHASES.filter((n) => r[`${n}_p50`] != null).map((n) => ({ name: n, p50: Number(r[`${n}_p50`]), p95: Number(r[`${n}_p95`]) })) }
    : null;
  const w = week?.[0] || {};
  return { ...main[0], ok7: Number(w.ok7 || 0), failed7: Number(w.failed7 || 0), ours7: Number(w.ours7 || 0),
    p50: w.p50 == null ? null : Number(w.p50), p95: w.p95 == null ? null : Number(w.p95),
    hosts: hosts || [], errors: errors || [], phases };
}

// Old rows are deleted after RETENTION_DAYS, or after the number of days a person chose in /privacy (0 = keep).
export function startRetention() {
  const run = () => q(
    `DELETE FROM downloads d USING users u
      WHERE u.telegram_id = d.user_id
        AND ((u.retention_days IS NULL AND d.created_at < now() - make_interval(days => $1::int))
          OR (u.retention_days > 0   AND d.created_at < now() - make_interval(days => u.retention_days)))`,
    [Math.floor(CFG.retentionDays)]
  );
  setTimeout(run, 60_000).unref();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}

import pg from 'pg';
import { CFG } from './config.js';

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

export async function shutdown() { if (pool) await pool.end().catch(() => {}); }

export async function touchUser(from) {
  const r = await q(
    `INSERT INTO users (telegram_id, username, first_name, requests) VALUES ($1, $2, $3, 1)
     ON CONFLICT (telegram_id) DO UPDATE
       SET username = EXCLUDED.username, first_name = EXCLUDED.first_name,
           last_seen = now(), requests = users.requests + 1
     RETURNING banned`,
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

export async function stats() {
  const main = await q(
    `SELECT (SELECT count(*) FROM users) AS users,
            count(*) AS total,
            count(*) FILTER (WHERE status = 'ok') AS ok,
            count(*) FILTER (WHERE cached) AS cached,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS last24h,
            COALESCE(avg(duration_ms) FILTER (WHERE status = 'ok' AND NOT cached), 0)::int AS avg_ms
       FROM downloads`
  );
  if (!main) return null;
  const hosts = await q(`SELECT host, count(*) AS c FROM downloads WHERE created_at > now() - interval '7 days' GROUP BY host ORDER BY c DESC LIMIT 5`);
  const errors = await q(`SELECT COALESCE(error_code,'unknown') AS code, count(*) AS c FROM downloads WHERE status = 'failed' AND created_at > now() - interval '7 days' GROUP BY 1 ORDER BY c DESC LIMIT 5`);
  const phases = await q(
    `SELECT round(avg((timings->>'fetch')::numeric))::int   AS fetch,
            round(avg((timings->>'browser')::numeric))::int AS browser,
            round(avg((timings->>'assets')::numeric))::int  AS assets,
            round(avg((timings->>'zip')::numeric))::int     AS zip,
            round(avg((timings->>'upload')::numeric))::int  AS upload,
            count(*) FILTER (WHERE mode = 'browser')        AS browser_jobs,
            count(*)                                        AS jobs
       FROM downloads
      WHERE status = 'ok' AND NOT cached AND timings IS NOT NULL AND created_at > now() - interval '7 days'`
  );
  return { ...main[0], hosts: hosts || [], errors: errors || [], phases: phases?.[0] || null };
}

export function startRetention() {
  const run = () => q(`DELETE FROM downloads WHERE created_at < now() - make_interval(days => $1::int)`, [Math.floor(CFG.retentionDays)]);
  setTimeout(run, 60_000).unref();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}

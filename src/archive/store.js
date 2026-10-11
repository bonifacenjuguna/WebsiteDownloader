import { queryStrict } from '../db.js';

// Storage behind the archive. Two implementations of ONE interface: Postgres (durable) and memory (no Postgres: nothing
// survives a restart, but everything else works). The service never knows which one it has.
//
// Entry   = one archived build. It has NO user column on purpose: deleting a person's data never touches the archive.
// Job     = one thing to do (post to Live, copy to Vault, post to Ops). Jobs are claimed with a lock that expires, so a crash
//           hands the job to the next worker, and two instances during a deploy never do the same job twice.
// Setting = small JSON values (which chats play which role, topic ids, last digest day).

const ENTRY_PATCH = {
  state: ['state'], error: ['error'], previewFileId: ['preview_file_id'], liveChat: ['live_chat'], liveLink: ['live_link'],
  livePosts: ['live_posts', 'json'], liveExpiresAt: ['live_expires_at', 'ts'], vaultChat: ['vault_chat'], vaultLink: ['vault_link'],
  vaultPosts: ['vault_posts', 'json'], vaultedAt: ['vaulted_at', 'ts'],
};

// ---------------------------------------------------------------- memory
export class MemoryStore {
  constructor() { this.entries = new Map(); this.jobs = new Map(); this.settings = new Map(); this.seq = 0; this.jobSeq = 0; this.durable = false; }

  async insertEntry(e) { const id = ++this.seq; this.entries.set(id, { livePosts: [], vaultPosts: [], liveChat: null, liveLink: null, liveExpiresAt: null, vaultChat: null, vaultLink: null, vaultedAt: null, error: null, ...e, id }); return id; }
  async getEntry(id) { const e = this.entries.get(id); return e ? structuredClone(e) : null; }
  async deleteEntry(id) { this.entries.delete(id); }
  async updateEntry(id, patch) { const e = this.entries.get(id); if (e) Object.assign(e, structuredClone(patch)); }
  async latestForKey(urlKey) {
    const hits = [...this.entries.values()].filter((e) => e.urlKey === urlKey && e.fileIds.length).sort((a, b) => b.createdAt - a.createdAt);
    return hits[0] ? structuredClone(hits[0]) : null;
  }
  async searchHost(term, limit) {
    const t = term.toLowerCase();
    return [...this.entries.values()].filter((e) => e.host.toLowerCase().includes(t)).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map((e) => structuredClone(e));
  }
  async dueExpiries(nowMs, limit) {
    return [...this.entries.values()].filter((e) => e.state === 'live' && e.liveExpiresAt != null && e.liveExpiresAt <= nowMs)
      .sort((a, b) => a.liveExpiresAt - b.liveExpiresAt).slice(0, limit).map((e) => structuredClone(e));
  }
  async stalePending(beforeMs, limit) { return [...this.entries.values()].filter((e) => e.state === 'pending' && e.createdAt < beforeMs).slice(0, limit).map((e) => structuredClone(e)); }
  async staleVaulting(beforeMs, limit) { return [...this.entries.values()].filter((e) => e.state === 'vaulting' && (e.liveExpiresAt ?? 0) < beforeMs).slice(0, limit).map((e) => structuredClone(e)); }
  async counts() {
    const c = {};
    for (const e of this.entries.values()) c[e.state] = (c[e.state] || 0) + 1;
    const j = {};
    for (const x of this.jobs.values()) j[x.state] = (j[x.state] || 0) + 1;
    return { entries: c, jobs: j };
  }

  async enqueue({ kind, role, payload, runAt, dedupe }) {
    if (dedupe && [...this.jobs.values()].some((j) => j.dedupe === dedupe && (j.state === 'pending' || j.state === 'running'))) return null;
    const id = ++this.jobSeq;
    this.jobs.set(id, { id, kind, role, payload: structuredClone(payload), runAt, dedupe: dedupe || null, state: 'pending', attempts: 0, lastError: null, lockedUntil: 0, createdAt: runAt });
    return id;
  }
  async claimDue(nowMs, limit, lockMs) {
    const due = [...this.jobs.values()]
      .filter((j) => (j.state === 'pending' && j.runAt <= nowMs) || (j.state === 'running' && j.lockedUntil < nowMs))
      .sort((a, b) => a.id - b.id).slice(0, limit);
    for (const j of due) { j.state = 'running'; j.lockedUntil = nowMs + lockMs; }
    return due.map((j) => structuredClone(j));
  }
  async updateJob(id, patch) { const j = this.jobs.get(id); if (j) Object.assign(j, patch); }
  async deleteJob(id) { this.jobs.delete(id); }
  async failedJobs(limit) { return [...this.jobs.values()].filter((j) => j.state === 'failed').sort((a, b) => b.id - a.id).slice(0, limit).map((j) => structuredClone(j)); }
  async retryFailed(nowMs) { let n = 0; for (const j of this.jobs.values()) if (j.state === 'failed') { Object.assign(j, { state: 'pending', attempts: 0, runAt: nowMs, lastError: null }); n++; } return n; }
  async pruneFailed(beforeMs) { for (const [id, j] of this.jobs) if (j.state === 'failed' && j.createdAt < beforeMs) this.jobs.delete(id); }

  async getSetting(key) { return this.settings.has(key) ? structuredClone(this.settings.get(key)) : null; }
  async setSetting(key, value) { this.settings.set(key, structuredClone(value)); }
}

// ---------------------------------------------------------------- postgres
const COLS = 'id, url_key, host, title, url, tag, file_ids, file_name, parts, pages, files, zip_bytes, mode, kind, preview_file_id, live_chat, live_posts, live_link, live_expires_at, vault_chat, vault_posts, vault_link, vaulted_at, state, error, created_at';
const num = (v) => (v == null ? null : Number(v));
const ms = (v) => (v == null ? null : new Date(v).getTime());
const toEntry = (r) => r && ({
  id: Number(r.id), urlKey: r.url_key, host: r.host, title: r.title || '', url: r.url || '', tag: r.tag,
  fileIds: String(r.file_ids || '').split(',').filter(Boolean), fileName: r.file_name, parts: r.parts, pages: r.pages, files: r.files,
  bytes: Number(r.zip_bytes || 0), mode: r.mode, kind: r.kind, previewFileId: r.preview_file_id,
  liveChat: num(r.live_chat), livePosts: r.live_posts || [], liveLink: r.live_link, liveExpiresAt: ms(r.live_expires_at),
  vaultChat: num(r.vault_chat), vaultPosts: r.vault_posts || [], vaultLink: r.vault_link, vaultedAt: ms(r.vaulted_at),
  state: r.state, error: r.error, createdAt: ms(r.created_at),
});
const toJob = (r) => ({ id: Number(r.id), kind: r.kind, role: r.role, payload: r.payload, state: r.state, attempts: r.attempts, runAt: ms(r.run_at), dedupe: r.dedupe_key, lastError: r.last_error, createdAt: ms(r.created_at) });
const like = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export class PgStore {
  constructor() { this.durable = true; }

  async insertEntry(e) {
    const r = await queryStrict(
      `INSERT INTO archive_entries (url_key, host, title, url, tag, file_ids, file_name, parts, pages, files, zip_bytes, mode, kind, preview_file_id, state, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, to_timestamp($16 / 1000.0)) RETURNING id`,
      [e.urlKey, e.host, e.title, e.url, e.tag, e.fileIds.join(','), e.fileName, e.parts, e.pages, e.files, e.bytes, e.mode, e.kind, e.previewFileId || null, e.state, e.createdAt],
    );
    return Number(r[0].id);
  }
  async getEntry(id) { return toEntry((await queryStrict(`SELECT ${COLS} FROM archive_entries WHERE id = $1`, [id]))[0]); }
  async deleteEntry(id) { await queryStrict('DELETE FROM archive_entries WHERE id = $1', [id]); }
  async updateEntry(id, patch) {
    const sets = [];
    const vals = [id];
    for (const [k, v] of Object.entries(patch)) {
      const spec = ENTRY_PATCH[k];
      if (!spec) throw new Error(`cannot update entry field ${k}`);
      vals.push(spec[1] === 'json' ? JSON.stringify(v ?? []) : v);
      const ph = `$${vals.length}`;
      sets.push(`${spec[0]} = ${spec[1] === 'json' ? `${ph}::jsonb` : spec[1] === 'ts' ? `to_timestamp(${ph}::double precision / 1000.0)` : ph}`);
    }
    if (sets.length) await queryStrict(`UPDATE archive_entries SET ${sets.join(', ')} WHERE id = $1`, vals);
  }
  async latestForKey(urlKey) {
    return toEntry((await queryStrict(`SELECT ${COLS} FROM archive_entries WHERE url_key = $1 AND file_ids <> '' ORDER BY created_at DESC LIMIT 1`, [urlKey]))[0]);
  }
  async searchHost(term, limit) {
    return (await queryStrict(`SELECT ${COLS} FROM archive_entries WHERE host ILIKE $1 ORDER BY created_at DESC LIMIT $2`, [like(term), limit])).map(toEntry);
  }
  async dueExpiries(nowMs, limit) {
    return (await queryStrict(`SELECT ${COLS} FROM archive_entries WHERE state = 'live' AND live_expires_at <= to_timestamp($1 / 1000.0) ORDER BY live_expires_at LIMIT $2`, [nowMs, limit])).map(toEntry);
  }
  async stalePending(beforeMs, limit) {
    return (await queryStrict(`SELECT ${COLS} FROM archive_entries WHERE state = 'pending' AND created_at < to_timestamp($1 / 1000.0) ORDER BY id LIMIT $2`, [beforeMs, limit])).map(toEntry);
  }
  async staleVaulting(beforeMs, limit) {
    return (await queryStrict(`SELECT ${COLS} FROM archive_entries WHERE state = 'vaulting' AND live_expires_at < to_timestamp($1 / 1000.0) ORDER BY id LIMIT $2`, [beforeMs, limit])).map(toEntry);
  }
  async counts() {
    const [e, j] = await Promise.all([
      queryStrict('SELECT state, count(*) AS n FROM archive_entries GROUP BY state'),
      queryStrict('SELECT state, count(*) AS n FROM archive_outbox GROUP BY state'),
    ]);
    return { entries: Object.fromEntries(e.map((r) => [r.state, Number(r.n)])), jobs: Object.fromEntries(j.map((r) => [r.state, Number(r.n)])) };
  }

  async enqueue({ kind, role, payload, runAt, dedupe }) {
    const r = await queryStrict(
      `INSERT INTO archive_outbox (kind, role, payload, run_at, dedupe_key, created_at)
       VALUES ($1, $2, $3::jsonb, to_timestamp($4 / 1000.0), $5, to_timestamp($4 / 1000.0))
       ON CONFLICT DO NOTHING RETURNING id`,
      [kind, role, JSON.stringify(payload), runAt, dedupe || null],
    );
    return r[0] ? Number(r[0].id) : null; // null = an identical job is already waiting
  }
  async claimDue(nowMs, limit, lockMs) {
    const r = await queryStrict(
      `UPDATE archive_outbox SET state = 'running', locked_until = to_timestamp($2 / 1000.0)
        WHERE id IN (SELECT id FROM archive_outbox
                      WHERE (state = 'pending' AND run_at <= to_timestamp($1 / 1000.0))
                         OR (state = 'running' AND locked_until < to_timestamp($1 / 1000.0))
                      ORDER BY id LIMIT $3 FOR UPDATE SKIP LOCKED)
        RETURNING id, kind, role, payload, state, attempts, run_at, dedupe_key, last_error, created_at`,
      [nowMs, nowMs + lockMs, limit],
    );
    return r.map(toJob).sort((a, b) => a.id - b.id);
  }
  async updateJob(id, patch) {
    const map = { state: 'state', attempts: 'attempts', lastError: 'last_error' };
    const sets = [];
    const vals = [id];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'runAt') { vals.push(v); sets.push(`run_at = to_timestamp($${vals.length}::double precision / 1000.0)`); }
      else if (map[k]) { vals.push(v); sets.push(`${map[k]} = $${vals.length}`); }
      else throw new Error(`cannot update job field ${k}`);
    }
    if (sets.length) await queryStrict(`UPDATE archive_outbox SET ${sets.join(', ')} WHERE id = $1`, vals);
  }
  async deleteJob(id) { await queryStrict('DELETE FROM archive_outbox WHERE id = $1', [id]); }
  async failedJobs(limit) {
    return (await queryStrict(`SELECT id, kind, role, payload, state, attempts, run_at, dedupe_key, last_error, created_at FROM archive_outbox WHERE state = 'failed' ORDER BY id DESC LIMIT $1`, [limit])).map(toJob);
  }
  async retryFailed(nowMs) {
    // a failed job whose twin is already waiting would break the "one active job per item" rule: drop it instead
    await queryStrict(`DELETE FROM archive_outbox f WHERE f.state = 'failed' AND f.dedupe_key IS NOT NULL
                         AND EXISTS (SELECT 1 FROM archive_outbox a WHERE a.dedupe_key = f.dedupe_key AND a.state IN ('pending', 'running'))`);
    const r = await queryStrict(`UPDATE archive_outbox SET state = 'pending', attempts = 0, last_error = NULL, run_at = to_timestamp($1 / 1000.0) WHERE state = 'failed' RETURNING id`, [nowMs]);
    return r.length;
  }
  async pruneFailed(beforeMs) { await queryStrict(`DELETE FROM archive_outbox WHERE state = 'failed' AND created_at < to_timestamp($1 / 1000.0)`, [beforeMs]); }

  async getSetting(key) { const r = await queryStrict('SELECT value FROM archive_settings WHERE key = $1', [key]); return r[0] ? r[0].value : null; }
  async setSetting(key, value) {
    await queryStrict(`INSERT INTO archive_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
  }
}

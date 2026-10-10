import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CFG } from './config.js';

// Shared asset cache. jQuery, Bootstrap, Font Awesome, Google Fonts files and friends are the same bytes on thousands of
// sites, so they are downloaded once and reused by every later job. Only URLs that can never change are cached:
// pinned versions on well-known CDNs, and content-hashed font files. The cache lives in the temp disk (it is only a
// speed-up: losing it costs nothing), is capped in size, and drops its least recently used files first.
const DIR = path.join(os.tmpdir(), 'wd-shared');
const MAX_ITEM = 4 * 1024 * 1024;

const HOSTS = [
  /^cdnjs\.cloudflare\.com$/, /^cdn\.jsdelivr\.net$/, /^unpkg\.com$/, /^ajax\.googleapis\.com$/, /^code\.jquery\.com$/,
  /^(stackpath|maxcdn)\.bootstrapcdn\.com$/, /^use\.fontawesome\.com$/, /^fonts\.gstatic\.com$/,
];
// a version in the path: @1.2.3, /1.2.3/, jquery-3.6.0.min.js, /releases/v6.4.0/
const PINNED = /@\d+\.\d+|\/\d+\.\d+(\.\d+)?[/.-]|-\d+\.\d+(\.\d+)?(\.min)?\.(js|css)$|\/releases\/v\d/i;

export function eligible(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (!HOSTS.some((r) => r.test(u.hostname))) return false;
  if (u.hostname === 'fonts.gstatic.com') return true;          // content-hashed paths
  if (/@latest\b|@\d+(\/|$)/.test(u.pathname)) return false;    // floating versions (@latest, @3) can change
  return PINNED.test(u.pathname);
}

const keyOf = (url) => crypto.createHash('sha1').update(url).digest('hex');
const counters = { hits: 0, misses: 0, puts: 0, approxBytes: 0 };
let pruning = false;
let sinceLastPrune = 0;

export const stats = () => ({ ...counters, enabled: CFG.sharedCacheBytes > 0 });

export async function get(url) {
  if (!CFG.sharedCacheBytes || !eligible(url)) return null;
  const k = keyOf(url);
  try {
    const [meta, buf] = await Promise.all([fs.readFile(path.join(DIR, `${k}.json`), 'utf8'), fs.readFile(path.join(DIR, `${k}.bin`))]);
    const type = JSON.parse(meta).type || '';
    const now = new Date();
    fs.utimes(path.join(DIR, `${k}.bin`), now, now).catch(() => {}); // "recently used" for the LRU
    counters.hits++;
    return { buf, type };
  } catch {
    counters.misses++;
    return null;
  }
}

export async function put(url, buf, type) {
  if (!CFG.sharedCacheBytes || !eligible(url) || !buf?.length || buf.length > MAX_ITEM) return;
  const k = keyOf(url);
  try {
    await fs.mkdir(DIR, { recursive: true });
    const tmp = path.join(DIR, `${k}.${process.pid}.tmp`);
    await fs.writeFile(tmp, buf);
    await fs.writeFile(path.join(DIR, `${k}.json`), JSON.stringify({ type, url }));
    await fs.rename(tmp, path.join(DIR, `${k}.bin`));
    counters.puts++;
    counters.approxBytes += buf.length;
    sinceLastPrune += buf.length;
    if (sinceLastPrune > CFG.sharedCacheBytes * 0.1) prune().catch(() => {});
  } catch { /* the cache is optional */ }
}

// keep the cache under its cap by removing the least recently used files
export async function prune() {
  if (pruning || !CFG.sharedCacheBytes) return;
  pruning = true;
  sinceLastPrune = 0;
  try {
    const names = (await fs.readdir(DIR).catch(() => [])).filter((n) => n.endsWith('.bin'));
    const files = [];
    let total = 0;
    for (const n of names) {
      const st = await fs.stat(path.join(DIR, n)).catch(() => null);
      if (st) { files.push({ n, size: st.size, at: st.mtimeMs }); total += st.size; }
    }
    counters.approxBytes = total;
    if (total <= CFG.sharedCacheBytes) return;
    files.sort((a, b) => a.at - b.at);
    for (const f of files) {
      if (total <= CFG.sharedCacheBytes * 0.9) break;
      const k = f.n.slice(0, -4);
      await Promise.all([fs.rm(path.join(DIR, f.n), { force: true }), fs.rm(path.join(DIR, `${k}.json`), { force: true })]);
      total -= f.size;
    }
    counters.approxBytes = total;
  } finally { pruning = false; }
}

export function startSharedCache() {
  const t = setInterval(() => { prune().catch(() => {}); }, 30 * 60 * 1000);
  t.unref();
  prune().catch(() => {});
  return () => clearInterval(t);
}

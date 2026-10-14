import { kv } from './store.js';
import { fetchHtml, fetchText } from './fetcher.js';
import { pool } from './assets.js';
import { CFG, MB } from './config.js';
import { signature } from './signature.js';
import { parseSitemapXml } from './site-util.js';

// "Has this site changed since I saved it?" Asked before a saved copy is sent again, so nobody gets stale content and
// nobody waits for a rebuild that was not needed.
//
// After every build we remember, per page: the ETag / Last-Modified the site gave and a signature of what the page says
// (see signature.js), plus the sitemaps the site published. Checking later costs a handful of small requests:
//   1. the sitemap says a page changed after we built?                 -> changed
//   2. a page answers "304 not modified", or its ETag or signature is the same   -> that page is the same
//   3. a page's signature differs                                       -> changed
// The verdict is one of: 'unchanged', 'changed', 'unknown' (no baseline, the site was slow or unreachable, or the time
// limit hit before every page was checked). 'unknown' never triggers a rebuild by itself.
const TTL = CFG.staleMaxDays * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 150;

export async function save(key, baseline) {
  if (!baseline?.entries?.length) return kv.del(`fp:${key}`);
  await kv.set(`fp:${key}`, JSON.stringify({ ...baseline, v: 2, entries: baseline.entries.slice(0, MAX_ENTRIES) }), TTL);
}

async function load(key) {
  try { const b = JSON.parse((await kv.get(`fp:${key}`)) || 'null'); return b?.v === 2 && b.entries?.length ? b : null; } catch { return null; }
}

// is there anything to compare with?
export async function available(key) { return !!(await load(key)); }

// last verdict, for /archive-style admin details
export async function lastCheck(key) { try { return JSON.parse((await kv.get(`probe:${key}`)) || 'null'); } catch { return null; } }

export async function probe(key, { timeoutMs = CFG.recheckTimeoutMs, now = () => Date.now() } = {}) {
  const cached = await lastCheck(key);
  if (cached && now() - cached.at < 60_000) return cached; // pressing the same thing again does not hit the site again
  const t0 = now();
  const done = async (verdict, reason, extra = {}) => {
    const res = { verdict, reason, ms: now() - t0, at: now(), ...extra };
    await kv.set(`probe:${key}`, JSON.stringify(res), 24 * 60 * 60 * 1000);
    return res;
  };

  const base = await load(key);
  if (!base) return done('unknown', 'no-baseline');
  const deadline = t0 + timeoutMs;
  const total = base.entries.length;

  // 1) the sitemap: one request, and it often settles the question for the whole site
  for (const sm of (base.sitemaps || []).slice(0, 3)) {
    if (now() > deadline) break;
    const text = await fetchText(sm, Math.max(1500, deadline - now()), 8 * MB);
    if (!text) continue;
    const { lastmod } = parseSitemapXml(text);
    for (const e of base.entries) {
      const when = lastmod.get(e.u) ?? lastmod.get(e.u.replace(/\/$/, '')) ?? lastmod.get(`${e.u}/`);
      if (when && when > base.at) return done('changed', 'sitemap', { checked: 0, total, page: e.u });
    }
  }

  // 2) the pages themselves, the home page first
  let checked = 0;
  let failures = 0;
  let timedOut = false;
  let changedAt = null;
  await pool(base.entries, 8, async (e) => {
    if (changedAt || now() > deadline) { if (!changedAt) timedOut = true; return; }
    const got = await fetchHtml(e.u, { etag: e.e, lastModified: e.m, signal: AbortSignal.timeout(Math.max(500, deadline - now())) });
    if (changedAt) return;
    if (got.notModified) { checked++; return; }
    if (got.fail || !got.html) { if (now() >= deadline) timedOut = true; else failures++; return; }
    checked++;
    if (e.e && got.etag && got.etag === e.e) return;                 // same ETag: same page
    if (signature(got.html) !== e.s) changedAt = e.u;
  });
  if (changedAt) return done('changed', 'page', { checked, total, page: changedAt });
  if (failures || timedOut || checked < total) return done('unknown', failures ? 'unreachable' : 'timeout', { checked, total });
  return done('unchanged', 'same', { checked, total });
}

import crypto from 'node:crypto';
import { kv } from './store.js';
import { fetchHtml } from './fetcher.js';
import { pool } from './assets.js';

// Incremental "fresh copy". After a build we remember each page's validators (ETag / Last-Modified) and a short
// content hash. When someone taps "Fresh copy", we ask the site whether anything changed (conditional requests,
// no downloads of assets, no ZIP, no upload). If nothing changed the saved copy is simply sent again.
const TTL = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 150;
export const hashOf = (html) => crypto.createHash('sha1').update(html).digest('hex').slice(0, 16);

export async function save(key, entries) {
  if (!entries?.length) return kv.del(`fp:${key}`);
  await kv.set(`fp:${key}`, JSON.stringify(entries.slice(0, MAX_ENTRIES)), TTL);
}

// 'unchanged' | 'changed' | null (no baseline to compare with)
export async function probe(key, { budgetMs = 20000 } = {}) {
  const cached = await kv.get(`probe:${key}`);
  if (cached) return cached;
  let entries;
  try { entries = JSON.parse((await kv.get(`fp:${key}`)) || 'null'); } catch { entries = null; }
  if (!entries?.length) return null;

  const until = Date.now() + budgetMs;
  let changed = false;
  await pool(entries, 8, async (e) => {
    if (changed || Date.now() > until) { changed = true; return; }
    const got = await fetchHtml(e.u, { etag: e.e, lastModified: e.m });
    if (got.notModified) return;
    if (got.fail || !got.html || hashOf(got.html) !== e.h) changed = true;
  });
  const result = changed ? 'changed' : 'unchanged';
  await kv.set(`probe:${key}`, result, 60 * 1000); // spamming the button does not spam the site
  return result;
}

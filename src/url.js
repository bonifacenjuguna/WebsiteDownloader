import net from 'node:net';
import crypto from 'node:crypto';
import { UserError } from './errors.js';

const invalid = () => new UserError("That doesn't look like a valid website address. Try something like example.com", 'invalid_url');

// Tracking parameters that never change what a page shows. Stripped so the same page always has the same cache key.
const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|igshid|igsh|mc_cid|mc_eid|_ga|_gl|ref_src|ref_url|spm|vero_id|mkt_tok|oly_enc_id|oly_anon_id|_hsenc|_hsmi|hsctatracking)$/i;

export function stripTracking(url) {
  for (const k of [...url.searchParams.keys()]) if (TRACKING.test(k)) url.searchParams.delete(k);
  return url;
}

export function normalizeUrl(input) {
  let s = String(input).trim().split(/\s+/)[0] || '';
  s = s.replace(/^[<(\[]+/, '').replace(/[>)\],.;!?]+$/, '');
  if (!s) throw invalid();
  const explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (!explicitScheme && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) throw invalid();
  if (!explicitScheme) s = 'https://' + s;
  let url;
  try { url = new URL(s); } catch { throw invalid(); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid();
  const h = url.hostname.replace(/^\[|\]$/g, '');
  if (!h || (!h.includes('.') && !net.isIP(h))) throw invalid();
  url.hash = '';
  url.username = '';
  url.password = '';
  stripTracking(url);
  return { url, explicitScheme };
}

// Finds website addresses anywhere in a message ("check out https://x.com/a, it's great") in reading order.
const SCHEME_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const BARE_RE = /(?<![@\w./-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{2,5})?(?:[/?#][^\s<>"'`]*)?/gi;
export function extractUrls(text) {
  const t = String(text || '');
  const hits = [];
  for (const m of t.matchAll(SCHEME_RE)) hits.push({ i: m.index, raw: m[0] });
  const covered = hits.map((h) => [h.i, h.i + h.raw.length]);
  for (const m of t.matchAll(BARE_RE)) {
    if (covered.some(([a, b]) => m.index >= a && m.index < b)) continue;
    hits.push({ i: m.index, raw: m[0] });
  }
  const seen = new Set();
  const out = [];
  for (const h of hits.sort((a, b) => a.i - b.i)) {
    let parsed;
    try { parsed = normalizeUrl(h.raw); } catch { continue; }
    const k = `${parsed.url.host}${parsed.url.pathname}${parsed.url.search}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(parsed);
  }
  return out;
}

// the registrable-looking host used for keys, caps and block lists: lower case, no leading www.
export const bareHost = (host) => String(host).toLowerCase().replace(/^www\./, '');

// Cache key for whole-site results (different from the single-page key of the same URL)
export const sectionKey = (key) => crypto.createHash('sha1').update(`${key}:site`).digest('hex');

// Stable cache key: same site/path/query -> same key (scheme, www. and trailing slash ignored)
export function urlKey(url) {
  let p = url.pathname;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return crypto.createHash('sha1').update(`${bareHost(url.host)}${p}${url.search}`).digest('hex');
}

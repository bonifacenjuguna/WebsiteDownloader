import net from 'node:net';
import crypto from 'node:crypto';
import { UserError } from './errors.js';

const invalid = () => new UserError("That doesn't look like a valid website address. Try something like example.com", 'invalid_url');

export function normalizeUrl(input) {
  let s = String(input).trim().split(/\s+/)[0] || '';
  s = s.replace(/^[<(\[]+/, '').replace(/[>)\],.;]+$/, '');
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
  return { url, explicitScheme };
}

// Cache key for /site results (different from the single-page key of the same URL)
export const sectionKey = (key) => crypto.createHash('sha1').update(`${key}:site`).digest('hex');

// Stable cache key: same site/path/query -> same key (scheme and trailing slash ignored)
export function urlKey(url) {
  let p = url.pathname;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return crypto.createHash('sha1').update(`${url.host.toLowerCase()}${p}${url.search}`).digest('hex');
}

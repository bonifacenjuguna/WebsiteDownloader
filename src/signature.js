import crypto from 'node:crypto';

// A fingerprint of what a page SAYS, not of how its bytes happen to look today. Two loads of an unchanged page often
// differ byte for byte (nonces, timestamps, tracking ids), so comparing raw HTML would call every site "changed".
// This keeps the things that change when a site really changes:
//   - the visible text (and the title), with clocks, dates-with-time and long counters removed
//   - the stylesheets and scripts the page loads (a redeploy renames them), keeping only version-like query parts
// and ignores everything else (inline scripts, attributes, comments, cache-busting query strings).
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '-', mdash: '-', hellip: '...' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
  return ENTITIES[e.toLowerCase()] ?? ' ';
});

export function visibleText(html) {
  const s = String(html);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] ?? '';
  const body = s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return decode(`${title} ${body}`)
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/g, ' ')   // timestamps
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?\b/gi, ' ')       // clocks
    .replace(/\b\d{9,}\b/g, ' ')                                              // counters, epoch times, ids
    .replace(/\s+/g, ' ')
    .trim();
}

// "/assets/app.3f9c.js?ver=2&_=1699999" -> "/assets/app.3f9c.js?ver=2"
const VERSIONISH = /^(v|ver|version|rev|hash|h|id)$/i;
export function assetName(url) {
  let u = String(url).trim().replace(/#.*$/, '').replace(/^(?:https?:)?\/\/[^/]+/i, '');
  const [path, query = ''] = u.split('?');
  const keep = query.split('&').filter((kv) => VERSIONISH.test(kv.split('=')[0])).sort();
  return keep.length ? `${path}?${keep.join('&')}` : path;
}

export function assetNames(html) {
  const s = String(html);
  const out = new Set();
  for (const m of s.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']?[^"'>]*stylesheet/i.test(m[0])) continue;
    const h = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (h) out.add(assetName(h[1]));
  }
  for (const m of s.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) out.add(assetName(m[1]));
  return [...out].sort();
}

export function signature(html) {
  return crypto.createHash('sha1').update(`${visibleText(html)}\n--\n${assetNames(html).join('\n')}`).digest('hex').slice(0, 16);
}

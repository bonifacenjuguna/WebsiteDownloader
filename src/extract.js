import path from 'node:path';
import { isTrackerUrl, INLINE_TRACKER, TRACKER_MENTION } from './trackers.js';

const SKIP = /^(data:|blob:|javascript:|about:|mailto:|tel:|sms:|#)/i;
const ASSET_REL = /(stylesheet|icon|manifest|mask-icon|preload|modulepreload|image_src)/i;
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(['"])(.*?)\1/gi;
const FROM = 'index.html';

export function decodeBody(buf, contentType = '') {
  let label = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!label) {
    const head = buf.subarray(0, 4096).toString('latin1');
    label = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try { return new TextDecoder(label || 'utf-8').decode(buf); }
  catch { return buf.toString('utf8'); }
}

export function resolveUrl(value, base) {
  if (!value) return null;
  const v = String(value).trim();
  if (!v || SKIP.test(v)) return null;
  try {
    const u = new URL(v, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

export function relPath(from, to) {
  const rel = path.posix.relative(path.posix.dirname(from), to);
  return rel.split('/').map(encodeURIComponent).join('/');
}

export function parseSrcset(v) {
  return String(v).split(/,\s+|,(?=\S+\s+\d)/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const [url, ...d] = s.split(/\s+/);
    return { url, desc: d.join(' ') };
  });
}

function assetRefs($) {
  const out = [];
  $('link[href]').each((_, el) => {
    if (ASSET_REL.test($(el).attr('rel') || '')) out.push([el, 'href', 'url']);
  });
  $('script[src]').each((_, el) => out.push([el, 'src', 'url']));
  $('img,source,video,audio,track,input,image,embed,object').each((_, el) => {
    for (const a of ['src', 'data-src', 'data-original', 'poster', 'data', 'xlink:href', 'href'])
      if (el.attribs[a]) out.push([el, a, 'url']);
    for (const a of ['srcset', 'data-srcset'])
      if (el.attribs[a]) out.push([el, a, 'srcset']);
  });
  return out;
}

export function cssRefs(css, base) {
  const out = new Set();
  for (const m of css.matchAll(CSS_URL)) { const u = resolveUrl(m[2], base); if (u) out.add(u); }
  for (const m of css.matchAll(CSS_IMPORT)) { const u = resolveUrl(m[2], base); if (u) out.add(u); }
  return out;
}

export function rewriteCss(css, base, from, map) {
  const swap = (v) => {
    const abs = resolveUrl(v, base);
    if (!abs) return null;
    const rec = map.get(abs);
    return rec ? relPath(from, rec.local) : abs; // not downloaded -> keep working online
  };
  return css
    .replace(CSS_URL, (m, q, u) => { const r = swap(u); return r ? `url("${r}")` : m; })
    .replace(CSS_IMPORT, (m, q, u) => { const r = swap(u); return r ? `@import "${r}"` : m; });
}

export function discover($, base) {
  const urls = new Set();
  const add = (v) => { const u = resolveUrl(v, base); if (u && !isTrackerUrl(u)) urls.add(u); };
  for (const [el, a, kind] of assetRefs($)) {
    const v = el.attribs[a];
    if (kind === 'srcset') parseSrcset(v).forEach((s) => add(s.url)); else add(v);
  }
  $('style').each((_, el) => { for (const u of cssRefs($(el).text(), base)) urls.add(u); });
  $('[style]').each((_, el) => { for (const u of cssRefs($(el).attr('style') || '', base)) urls.add(u); });
  return urls;
}

function stripTrackers($, base) {
  const tracked = (v) => { const u = resolveUrl(v, base); return !!u && isTrackerUrl(u); };
  $('script[src]').each((_, el) => { if (tracked($(el).attr('src'))) $(el).remove(); });
  $('script:not([src])').each((_, el) => {
    const type = ($(el).attr('type') || '').toLowerCase();
    if (type && !/javascript|module/.test(type)) return; // leave JSON data blocks alone
    const code = $(el).html() || '';
    if (code.length < 3000 && INLINE_TRACKER.test(code)) $(el).remove();
  });
  $('link[href]').each((_, el) => { if (tracked($(el).attr('href'))) $(el).remove(); });
  $('img[src],iframe[src]').each((_, el) => { if (tracked($(el).attr('src'))) $(el).remove(); });
  $('noscript').each((_, el) => { if (TRACKER_MENTION.test($(el).html() || '')) $(el).remove(); });
  $('style').each((_, el) => { if (/async-hide/.test($(el).text())) $(el).remove(); }); // A/B-test anti-flicker CSS
}

export function rewriteHtml($, base, map, { stripScripts = false } = {}) {
  const swap = (v) => {
    const abs = resolveUrl(v, base);
    if (!abs) return v;
    const rec = map.get(abs);
    return rec ? relPath(FROM, rec.local) : abs;
  };
  stripTrackers($, base);
  for (const [el, a, kind] of assetRefs($)) {
    const v = el.attribs[a];
    const out = kind === 'srcset'
      ? parseSrcset(v).map(({ url, desc }) => `${swap(url)}${desc ? ' ' + desc : ''}`).join(', ')
      : swap(v);
    $(el).attr(a, out);
  }
  $('style').each((_, el) => { $(el).text(rewriteCss($(el).text(), base, FROM, map)); });
  $('[style]').each((_, el) => { $(el).attr('style', rewriteCss($(el).attr('style') || '', base, FROM, map)); });

  // page links stay pointing at the live site
  const absolutize = (sel, attr) => $(sel).each((_, el) => {
    const v = ($(el).attr(attr) || '').trim();
    if (!v || SKIP.test(v)) return;
    try { $(el).attr(attr, new URL(v, base).href); } catch { /* ignore */ }
  });
  absolutize('a[href],area[href]', 'href');
  absolutize('form[action]', 'action');

  // things that break when opened from disk
  $('base').remove();
  $('[integrity]').removeAttr('integrity');
  $('[crossorigin]').removeAttr('crossorigin');
  $('meta[charset]').remove();
  $('meta[http-equiv]').each((_, el) => {
    const h = ($(el).attr('http-equiv') || '').toLowerCase();
    if (h === 'content-type' || h === 'content-security-policy') $(el).remove();
  });
  if (stripScripts) {
    $('script').remove();
    $('link[rel="modulepreload"], link[rel="preload"][as="script"]').remove();
  }
  $('head').prepend('<meta charset="utf-8">');
  return $.html();
}

import path from 'node:path';
import { isTrackerUrl, INLINE_TRACKER, TRACKER_MENTION } from './trackers.js';

const SKIP = /^(data:|blob:|javascript:|about:|mailto:|tel:|sms:|#)/i;
const ASSET_REL = /(stylesheet|icon|manifest|mask-icon|preload|modulepreload|image_src)/i;
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(['"])(.*?)\1/gi;
const CSS_IMAGESET = /image-set\(([^)]*)\)/gi;   // image-set("a.png" 1x, "b.png" 2x): plain strings, no url()
const CSS_STR = /(['"])(.*?)\1/g;
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
  // WHATWG-style: a candidate is "url [descriptor]" and candidates are separated by a comma that follows whitespace,
  // or by a comma right after a descriptor. A comma inside a URL (e.g. /img/w_300,h_200/a.jpg) is part of the URL.
  const out = [];
  const s = String(v).trim();
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    let url = s.slice(i, j);
    let desc = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, ''); // "a.jpg, b.jpg": no descriptor
    } else {
      let k = j;
      while (k < s.length && s[k] !== ',') k++;
      desc = s.slice(j, k).trim();
      j = k;
    }
    if (url) out.push({ url, desc });
    i = j + 1;
  }
  return out;
}

const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-bg', 'data-background', 'data-background-image', 'data-image', 'data-poster', 'data-full', 'data-hi-res-src'];
const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset'];

function assetRefs($) {
  const out = [];
  $('link[href]').each((_, el) => {
    if (ASSET_REL.test($(el).attr('rel') || '')) out.push([el, 'href', 'url']);
  });
  $('script[src]').each((_, el) => out.push([el, 'src', 'url']));
  $('img,source,video,audio,track,input,image,embed,object,use').each((_, el) => {
    for (const a of ['src', 'poster', 'data', 'xlink:href', 'href'])
      if (el.attribs[a]) out.push([el, a, 'url']);
  });
  // lazy-loading attributes on ANY element (div backgrounds, sliders, ...)
  $(LAZY_ATTRS.map((a) => `[${a}]`).join(',')).each((_, el) => {
    for (const a of LAZY_ATTRS) if (el.attribs[a] && !/^\s*[{\[]/.test(el.attribs[a])) out.push([el, a, 'url']);
  });
  $('img,source,[srcset],[data-srcset],[data-lazy-srcset]').each((_, el) => {
    for (const a of ['srcset', ...LAZY_SRCSET]) if (el.attribs[a]) out.push([el, a, 'srcset']);
  });
  // an element can match two selectors: keep each (element, attribute) once
  const seen = new WeakMap();
  return out.filter(([el, a]) => {
    const set = seen.get(el) || seen.set(el, new Set()).get(el);
    if (set.has(a)) return false;
    set.add(a);
    return true;
  });
}

export function cssRefs(css, base) {
  const out = new Set();
  for (const m of css.matchAll(CSS_URL)) { const u = resolveUrl(m[2], base); if (u) out.add(u); }
  for (const m of css.matchAll(CSS_IMPORT)) { const u = resolveUrl(m[2], base); if (u) out.add(u); }
  for (const m of css.matchAll(CSS_IMAGESET))
    for (const s of m[1].matchAll(CSS_STR)) { const u = resolveUrl(s[2], base); if (u) out.add(u); }
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
    .replace(CSS_IMPORT, (m, q, u) => { const r = swap(u); return r ? `@import "${r}"` : m; })
    .replace(CSS_IMAGESET, (m, inner) => `image-set(${inner.replace(CSS_STR, (mm, q, u) => { const r = swap(u); return r ? `"${r}"` : mm; })})`);
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

// New href for a page link: relative if that page was saved too, otherwise the live absolute URL.
export function rewriteLink(v, base, from, pageLookup) {
  const t = String(v || '').trim();
  if (!t || SKIP.test(t)) return null;
  try {
    const u = new URL(t, base);
    if (pageLookup) {
      const bare = new URL(u.href);
      bare.hash = '';
      const local = pageLookup(bare.href);
      if (local) return relPath(from, local) + u.hash;
    }
    return u.href;
  } catch { return null; }
}

export function rewriteHtml($, base, map, { stripScripts = false, from = FROM, pageLookup = null } = {}) {
  const swap = (v) => {
    const abs = resolveUrl(v, base);
    if (!abs) return v;
    const rec = map.get(abs);
    return rec ? relPath(from, rec.local) : abs;
  };
  stripTrackers($, base);
  for (const [el, a, kind] of assetRefs($)) {
    const v = el.attribs[a];
    const out = kind === 'srcset'
      ? parseSrcset(v).map(({ url, desc }) => `${swap(url)}${desc ? ' ' + desc : ''}`).join(', ')
      : swap(v);
    $(el).attr(a, out);
  }
  $('style').each((_, el) => { $(el).text(rewriteCss($(el).text(), base, from, map)); });
  $('[style]').each((_, el) => { $(el).attr('style', rewriteCss($(el).attr('style') || '', base, from, map)); });

  // page links stay pointing at the live site, unless the target page was saved too (/site)
  const retarget = (sel, attr, lookup) => $(sel).each((_, el) => {
    const out = rewriteLink($(el).attr(attr), base, from, lookup);
    if (out) $(el).attr(attr, out);
  });
  retarget('a[href],area[href]', 'href', pageLookup);
  retarget('form[action]', 'action', null);

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

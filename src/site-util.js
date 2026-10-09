// Pure helpers for /site (no network, no HTML parser) so they can be tested in isolation.
import { resolveUrl, relPath } from './extract.js';
import { clean, decode } from './paths.js';

// ---------- robots.txt (User-agent: * only) ----------
export function parseRobots(text) {
  const rules = [];
  let applies = false;
  let inHeader = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === 'user-agent') {
      if (!inHeader) applies = false; // a new group starts
      inHeader = true;
      if (v === '*') applies = true;
      continue;
    }
    inHeader = false;
    if (!applies || !v) continue;
    if (k === 'disallow') rules.push({ allow: false, pattern: v });
    else if (k === 'allow') rules.push({ allow: true, pattern: v });
  }
  return rules;
}

const toRe = (p) => {
  const end = p.endsWith('$');
  const body = (end ? p.slice(0, -1) : p).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${end ? '$' : ''}`);
};

export function robotsAllows(rules, pathname) {
  let best = null;
  for (const r of rules) {
    if (!toRe(r.pattern).test(pathname)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

// ---------- page identity ----------
// key = "host/path" with index files and trailing slashes folded away, so /docs, /docs/ and /docs/index.html are one page
export function pageKey(abs) {
  const u = new URL(abs);
  let p = u.pathname.replace(/\/index\.(html?|php)$/i, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return `${u.host}${p}`;
}

// where the page lives inside the ZIP
export function pageLocal(key) {
  const p = key.slice(key.indexOf('/'));
  const segs = p.split('/').filter(Boolean).map((s) => clean(decode(s)));
  if (!segs.length) return 'index.html';
  const last = segs[segs.length - 1];
  if (/\.(html?|php|aspx?|shtml)$/i.test(last)) {
    segs[segs.length - 1] = last.replace(/\.(php|aspx?|shtml)$/i, '.html'); // so a double-click opens it
    return segs.join('/');
  }
  return [...segs, 'index.html'].join('/');
}

// "/docs" -> "/docs/", "/docs/a.html" -> "/docs/", "/" -> "/"
export function scopePathOf(pathname) {
  if (pathname.endsWith('/')) return pathname;
  const last = pathname.split('/').pop();
  if (last.includes('.')) return pathname.slice(0, pathname.lastIndexOf('/') + 1);
  return `${pathname}/`;
}

const PAGE_EXT = /\.(html?|php|aspx?|shtml)$/i;

// links worth following: same host, inside the section, no query strings, and not files like PDFs or images
export function pageLinksFromHrefs(hrefs, base, scope) {
  const out = new Set();
  for (const h of hrefs) {
    const abs = resolveUrl(h, base);
    if (!abs) continue;
    const u = new URL(abs);
    if (u.host !== scope.host || u.search) continue;
    if (!(u.pathname.startsWith(scope.path) || `${u.pathname}/` === scope.path)) continue;
    const last = u.pathname.split('/').pop();
    if (last && last.includes('.') && !PAGE_EXT.test(last)) continue;
    out.add(pageKey(abs));
  }
  return out;
}

// ---------- open directory listings ("Index of /files/") ----------
export const isListingTitle = (title, h1) => {
  const re = /^(index of|directory listing for)\b/i;
  return re.test(String(title || '').trim()) || re.test(String(h1 || '').trim());
};

// split a listing's links into sub-folders and files that live BELOW the current folder
export function classifyListingHrefs(hrefs, curUrl) {
  const cur = new URL(curUrl);
  const dirs = new Set();
  const files = new Set();
  for (const h of hrefs) {
    const t = String(h || '').trim();
    if (!t || t.startsWith('?') || t.startsWith('#')) continue; // sort links like ?C=N;O=D
    const abs = resolveUrl(t, cur.href);
    if (!abs) continue;
    const u = new URL(abs);
    if (u.host !== cur.host || u.search) continue;
    if (!u.pathname.startsWith(cur.pathname) || u.pathname.length <= cur.pathname.length) continue; // parent / self
    (u.pathname.endsWith('/') ? dirs : files).add(u.href);
  }
  return { dirs: [...dirs], files: [...files] };
}

export function listingLocal(fileUrl, rootPath) {
  return new URL(fileUrl).pathname.slice(rootPath.length).split('/').map((s) => clean(decode(s))).filter(Boolean).join('/');
}

// first-fit-decreasing into ZIP parts; whatever does not fit in maxParts is returned as overflow
export function packParts(files, capacity, maxParts) {
  const bins = [];
  const overflow = [];
  for (const f of [...files].sort((a, b) => b.size - a.size)) {
    let bin = bins.find((b) => b.bytes + f.size <= capacity);
    if (!bin) {
      if (bins.length >= maxParts) { overflow.push(f); continue; }
      bin = { files: [], bytes: 0 };
      bins.push(bin);
    }
    bin.files.push(f);
    bin.bytes += f.size;
  }
  return { bins, overflow };
}

// Packs files into ZIP parts. Highest rank (code/pages) is placed first, so when parts run out it is
// media that gets left out, never code. A file bigger than one part simply gets a part of its own.
export function packPrioritized(files, { capacity, maxParts, weigh, rankOf, pinned = [] }) {
  const bins = [{ files: [...pinned], bytes: pinned.reduce((n, f) => n + weigh(f), 0) }];
  const overflow = [];
  const ordered = [...files].sort((a, b) => rankOf(b) - rankOf(a) || weigh(b) - weigh(a));
  for (const f of ordered) {
    const w = weigh(f);
    let bin = bins.find((b) => b.bytes + w <= capacity);
    if (!bin) {
      if (bins.length >= maxParts) { overflow.push(f); continue; }
      bin = { files: [], bytes: 0 };
      bins.push(bin);
    }
    bin.files.push(f);
    bin.bytes += w;
  }
  return { bins: bins.filter((b) => b.files.length), overflow };
}

// documents and media linked from pages (PDFs, archives, ...): same host, no query string
const DOC_EXT = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|txt|zip|gz|tgz|7z|rar|epub|mp3|m4a|wav|ogg|mp4|webm|mov)$/i;
export function fileLinksFromHrefs(hrefs, base, host) {
  const out = new Set();
  for (const h of hrefs) {
    const abs = resolveUrl(h, base);
    if (!abs) continue;
    const u = new URL(abs);
    if (u.host === host && !u.search && DOC_EXT.test(u.pathname)) out.add(u.href);
  }
  return out;
}

export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function listingIndexHtml(host, rootPath, files, part, parts, sizeLabel) {
  const rows = files.map((f) =>
    `<li><a href="${escapeHtml(relPath('index.html', f.local))}">${escapeHtml(f.local)}</a> <small>${sizeLabel(f.size)}</small></li>`).join('\n');
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(host + rootPath)}</title>
<style>body{font:16px system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}li{margin:.3rem 0;word-break:break-all}small{color:#666}</style>
<h1>${escapeHtml(host + rootPath)}</h1>
<p>${parts > 1 ? `Part ${part} of ${parts}: ` : ''}${files.length} file${files.length === 1 ? '' : 's'}</p>
<ul>
${rows}
</ul>
`;
}

// ---------- sitemaps ----------
export function sitemapsFromRobots(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(raw.replace(/#.*/, ''));
    if (m) out.push(m[1]);
  }
  return out;
}

const unxml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/<!\[CDATA\[|\]\]>/g, '').trim();

// Handles both <urlset> (pages) and <sitemapindex> (more sitemaps). Regex is enough for this flat format.
export function parseSitemapXml(text) {
  const urls = [];
  const maps = [];
  const t = String(text);
  if (/<sitemapindex[\s>]/i.test(t)) {
    for (const m of t.matchAll(/<sitemap[\s>][\s\S]*?<loc>([\s\S]*?)<\/loc>/gi)) maps.push(unxml(m[1]));
  } else {
    for (const m of t.matchAll(/<url[\s>][\s\S]*?<loc>([\s\S]*?)<\/loc>/gi)) urls.push(unxml(m[1]));
  }
  return { urls, maps };
}

// shallow pages first: when a sitemap has thousands of URLs and only some fit, the top of the site matters most
export function sortShallowFirst(keys) {
  const depth = (k) => k.split('/').filter(Boolean).length;
  return [...keys].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

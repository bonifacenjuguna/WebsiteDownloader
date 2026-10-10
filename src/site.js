import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import * as cheerio from 'cheerio';
import { CFG, MB, TG_MAX_BYTES, mb } from './config.js';
import { UserError } from './errors.js';
import { safeFetch, readBody } from './net.js';
import { Job } from './job.js';
import { analyze, looksLikeSpa, looksThin, isChallengeHtml, isBotWallHtml, visibleTextLength, LOGIN_PATH } from './analyze.js';
import { decodeBody, rewriteHtml, relPath } from './extract.js';
import { collectAssets, rewriteCssFiles, fetchAsset, pool } from './assets.js';
import { rank, estimate } from './trim.js';
import { renderWithBrowser, browserSem } from './browser.js';
import { zipEntries } from './zip.js';
import { fetchMain, fetchHtml } from './fetcher.js';
import { tr } from './copy.js';
import { compressImages } from './compress.js';
import { checkLinks } from './checks.js';
import { hashOf } from './fingerprint.js';
import {
  parseRobots, robotsAllows, pageKey, pageLocal, scopePathOf, pageLinksFromHrefs, sitemapsFromRobots, parseSitemapXml, sortShallowFirst,
  isListingTitle, classifyListingHrefs, listingLocal, packParts, packPrioritized, fileLinksFromHrefs, listingIndexHtml, escapeHtml,
} from './site-util.js';

const hrefsOf = ($) => { const out = []; $('a[href]').each((_, el) => out.push($(el).attr('href'))); return out; };
const titleOf = (html) => cheerio.load(html)('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 80);
const bytesOf = (str) => Buffer.byteLength(str, 'utf8');
const hostFile = (job) => job.main.hostname.replace(/[^a-z0-9.-]/gi, '_');

function skippedText(job) {
  const lines = [];
  const cap = 200;
  const block = (title, items, fmt) => {
    if (!items.length) return;
    if (lines.length) lines.push('');
    lines.push(title);
    for (const i of items.slice(0, cap)) lines.push(`  ${fmt(i)}`);
    if (items.length > cap) lines.push(`  ...and ${items.length - cap} more`);
  };
  block('SKIPPED (limits, size, robots.txt or sign-in):', job.skipped, (s) => `${s.url} - ${s.reason}${s.size ? ` (${mb(s.size)} MB)` : ''}`);
  block('COULD NOT BE DOWNLOADED:', job.failed, (f) => `${f.url} - ${f.reason}`);
  if (job.timedOut) lines.push('', 'NOTE: the time limit was reached, so the result is incomplete.');
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// a small text resource (robots.txt, sitemap.xml); .gz sitemaps are unpacked; failures just return ''
async function fetchText(url, timeoutMs, maxBytes, signal) {
  try {
    const { res } = await safeFetch(url, { timeoutMs, signal });
    if (!res.ok) { res.body?.cancel().catch(() => {}); return ''; }
    const b = await readBody(res, maxBytes);
    if (b.tooBig) return '';
    let buf = b.buf;
    if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf); } catch { return ''; } }
    return buf.toString('utf8');
  } catch { return ''; }
}

// Sitemap-first discovery: the pages a site lists itself, shallow ones first. Link-following still runs on top,
// so pages missing from the sitemap are found too.
async function readSitemaps(start, robotsText, scope, signal) {
  const sameHost = (u) => { try { return new URL(u).host === start.host; } catch { return false; } };
  const roots = sitemapsFromRobots(robotsText).filter(sameHost);
  if (!roots.length) roots.push(`${start.origin}/sitemap.xml`);
  const queue = [...new Set(roots)];
  const seenMaps = new Set(queue);
  const hrefs = [];
  for (let fetched = 0; queue.length && fetched < 8 && hrefs.length < CFG.siteSitemapMax * 3; fetched++) {
    const text = await fetchText(queue.shift(), 10000, 8 * MB, signal);
    if (!text) continue;
    const { urls, maps } = parseSitemapXml(text);
    hrefs.push(...urls);
    for (const m of maps) if (!seenMaps.has(m) && sameHost(m)) { seenMaps.add(m); queue.push(m); }
  }
  return sortShallowFirst([...pageLinksFromHrefs(hrefs, start.href, scope)]).slice(0, CFG.siteSitemapMax);
}

// ---------------------------------------------------------------- entry point
// One entry for everything: a folder listing is downloaded as files, anything else is crawled as a whole site
// (or, when the link points deeper than the home page, as that part of the site).
// The pipeline decides by itself how to get in: plain fetch, a real browser, a stealthier browser, page by page.
export async function downloadWebsite(parsed, workDir, onStatus = () => {}, opts = {}) {
  const L = opts.L || tr('en');
  const timings = {};
  const siteDir = path.join(workDir, 'site');
  await fs.mkdir(siteDir, { recursive: true });

  let t = Date.now();
  onStatus(L.STATUS.opening(parsed.url.host));
  const first = await fetchMain(parsed.url, parsed.explicitScheme, opts.signal);
  timings.fetch = Date.now() - t;

  const isHtml = !first.contentType || /html/i.test(first.contentType);
  const html0 = isHtml ? decodeBody(first.buf, first.contentType) : '';
  if (first.status < 400 && !isHtml)
    throw new UserError(`📄 That link isn't a web page (it's ${first.contentType.split(';')[0]}). Send a page or folder address instead.`, 'not_html');

  const check = analyze({
    status: first.status, headers: first.headers, html: html0,
    requestedUrl: parsed.url.href, finalUrl: first.finalUrl, isHtml,
  });
  if (check.fatal && !check.challenge) throw new UserError(check.fatal, check.code);
  if (check.challenge && !CFG.enableBrowser) throw new UserError(check.fatal, check.code);

  const $ = cheerio.load(html0);
  const listing = !check.challenge && isListingTitle($('title').first().text(), $('h1').first().text());
  const c = { first, html0, workDir, siteDir, onStatus, timings, warnings: [...check.warnings], check, opts, L, S: L.STATUS };
  return listing ? runListing(c) : runWebsite(c);
}

// ---------------------------------------------------------------- open folder listing
async function runListing({ first, html0, workDir, siteDir, onStatus, timings, warnings, opts, S }) {
  const PART = CFG.partBytes - MB; // room for index/readme inside each ZIP
  const start = new URL(first.finalUrl);
  start.search = '';
  start.hash = '';
  if (!start.pathname.endsWith('/')) start.pathname += '/';
  const rootPath = start.pathname;

  const job = new Job(siteDir, start.href, {
    maxFiles: CFG.siteMaxFiles,
    maxTotalBytes: Math.min(CFG.siteMaxTotalBytes, CFG.siteMaxParts * PART),
    timeoutMs: CFG.siteTimeoutMs,
    fetchTimeoutMs: 120000, // big files need time
    signal: opts.signal,
  });

  let t = Date.now();
  // 1) walk the folder tree
  const dirsSeen = new Set([start.href]);
  const queue = [{ url: start.href, depth: 0, html: html0 }];
  const fileUrls = new Set();
  let scanned = 0;
  while (queue.length && !job.expired()) {
    const d = queue.shift();
    let html = d.html;
    if (html == null) {
      const got = await fetchHtml(d.url, { signal: opts.signal });
      if (got.fail) { job.failed.push({ url: d.url, reason: `could not read folder (${got.fail})` }); continue; }
      html = got.html;
    }
    const $ = cheerio.load(html);
    if (d.depth > 0 && !isListingTitle($('title').first().text(), $('h1').first().text())) {
      job.failed.push({ url: d.url, reason: 'not a folder listing' });
      continue;
    }
    scanned++;
    onStatus(S.folders(scanned, fileUrls.size));
    const { dirs, files } = classifyListingHrefs(hrefsOf($), d.url);
    for (const f of files) fileUrls.add(f);
    for (const sd of dirs) {
      if (dirsSeen.has(sd)) continue;
      if (d.depth >= 5 || dirsSeen.size >= CFG.siteMaxDirs) {
        job.skipped.push({ url: sd, reason: d.depth >= 5 ? 'folder nested too deep' : `folder limit (${CFG.siteMaxDirs}) reached` });
        dirsSeen.add(sd);
        continue;
      }
      dirsSeen.add(sd);
      queue.push({ url: sd, depth: d.depth + 1, html: null });
    }
  }
  job.throwIfCancelled();

  let list = [...fileUrls];
  if (list.length > CFG.siteMaxFiles) {
    for (const u of list.slice(CFG.siteMaxFiles)) job.skipped.push({ url: u, reason: `file limit (${CFG.siteMaxFiles}) reached` });
    list = list.slice(0, CFG.siteMaxFiles);
  }
  if (!list.length)
    throw new UserError('📂 That folder listing has no files I can download.', 'empty_listing');

  // 2) download, keeping the folder structure relative to the listing you sent
  for (const u of list) job.localOverrides.set(u, listingLocal(u, rootPath));
  let lastEmit = 0;
  job.progress.total = list.length;
  await pool(list, 3, async (u) => {
    await fetchAsset(job, u);
    job.progress.done++;
    const n = Date.now();
    if (n - lastEmit > 1200 && job.progress.done < job.progress.total) {
      lastEmit = n;
      onStatus(S.files(job.progress.done, job.progress.total));
    }
  });
  job.throwIfCancelled();
  timings.assets = Date.now() - t;
  if (!job.files.size)
    throw new UserError(`📂 I couldn't download any files from that folder (each must be under ${mb(CFG.maxFileBytes)} MB).`, 'listing_unsavable');

  // 3) pack into Telegram-sized ZIP parts
  t = Date.now();
  onStatus(S.zip);
  const { bins, overflow } = packParts([...job.files.values()], PART, CFG.siteMaxParts);
  for (const f of overflow) {
    job.files.delete(f.url);
    job.skipped.push({ url: f.url, reason: `did not fit in ${CFG.siteMaxParts} ZIP parts`, size: f.size });
  }
  if (overflow.length) warnings.push({ c: 'overflow', n: overflow.length });

  const n = bins.length;
  const skipText = skippedText(job);
  const parts = [];
  for (let i = 0; i < n; i++) {
    job.throwIfCancelled();
    const files = bins[i].files.sort((a, b) => a.local.localeCompare(b.local));
    const readme = [
      `Website Downloader - files from ${job.main.host}${rootPath}`,
      `Saved: ${new Date().toISOString()}`,
      '',
      n > 1 ? `This is part ${i + 1} of ${n}. Unzip all parts into the same folder; each keeps the original folder paths.` : 'Open index.html for a clickable list of the files.',
      ...(skipText && i === 0 ? ['', 'See skipped.txt for files that were left out.'] : []),
    ].join('\n');
    const entries = [
      { name: 'index.html', text: listingIndexHtml(job.main.host, rootPath, files, i + 1, n, (b) => `${mb(b)} MB`) },
      { name: 'README.txt', text: `${readme}\n` },
      ...(i === 0 && skipText ? [{ name: 'skipped.txt', text: skipText }] : []),
      ...files.map((f) => ({ name: f.local, file: path.join(job.dir, f.local) })),
    ];
    const zipName = `${hostFile(job)}-files${n > 1 ? `-part${i + 1}of${n}` : ''}.zip`;
    const zipPath = path.join(workDir, zipName);
    await zipEntries(zipPath, entries);
    const { size } = await fs.stat(zipPath);
    if (size > TG_MAX_BYTES) throw new UserError(`📦 A ZIP part came out at ${mb(size)} MB, over Telegram's limit.`, 'zip_too_big');
    parts.push({ zipPath, zipName, bytes: size });
  }
  timings.zip = Date.now() - t;
  if (job.timedOut) warnings.push({ c: 'slow' });

  return {
    kind: 'listing', parts, host: job.main.host, title: rootPath,
    dirCount: dirsSeen.size, fileCount: job.files.size,
    zipBytes: parts.reduce((s, p) => s + p.bytes, 0),
    mode: 'site-files', warnings, skipped: job.skipped.length, failed: job.failed.length, timings, fingerprint: null,
  };
}

// ---------------------------------------------------------------- a whole website (or a part of one)
async function runWebsite({ first, html0, workDir, siteDir, onStatus, timings, warnings, check, opts, S }) {
  const start = new URL(first.finalUrl);
  start.hash = '';
  const scope = { host: start.host, path: scopePathOf(start.pathname) }; // "/" = the whole site
  const job = new Job(siteDir, start.href, {
    timeoutMs: CFG.siteTimeoutMs,
    maxTotalBytes: CFG.siteMaxTotalBytes,
    maxFiles: 5000,
    fetchTimeoutMs: 60000, // big files need time
    signal: opts.signal,
  });
  job.used.add('_all-pages.html');

  // ---- the browser ladder, decided automatically ----
  // 1) plain fetch (fast, keeps the site's own scripts)  2) real browser  3) stealthier browser that waits for bot checks.
  // Pages rendered in a browser are saved as snapshots (scripts removed); plain pages keep their scripts.
  const browserOn = CFG.enableBrowser;
  let browserBudget = CFG.siteMaxPagesBrowser; // how many pages may use the (slow) browser
  let stealth = false;                         // once the plain browser was turned away, later pages start stealthy
  let thinMisses = 0;                          // thin pages where rendering added nothing: stop trying after a few
  const render = async (url) => {
    const attempt = async (st) => {
      try {
        const r = await browserSem.run(() => renderWithBrowser(job, url, { stealth: st }));
        return r.challenge ? { fail: 'challenge' } : { html: r.html, finalUrl: r.finalUrl, original: r.originalHtml };
      } catch (e) { return { fail: e?.message || 'browser error' }; }
    };
    let got = await attempt(stealth);
    if (got.fail === 'challenge' && !stealth) {
      stealth = true;
      onStatus(S.browser2);
      got = await attempt(true);
    }
    return got;
  };
  const tryBrowser = async (url) => {
    if (!browserOn || browserBudget <= 0) return { fail: 'browser not available' };
    browserBudget--;
    return render(url);
  };

  // ---- the first page ----
  let t = Date.now();
  let startHtml = html0;
  let startRendered = false;
  let startOriginal = null;
  let spaSite = false;
  const trouble = check.challenge ? 'challenge' : looksLikeSpa(html0) ? 'spa' : looksThin(html0) ? 'thin' : null;
  if (trouble && browserOn) {
    onStatus(S.browser);
    const r = await tryBrowser(first.finalUrl);
    if (r.fail) {
      if (check.challenge) throw new UserError(check.fatal, check.code);
      if (trouble === 'spa') warnings.push({ c: 'browserFallback' });
    } else if (trouble === 'thin' && visibleTextLength(r.html) <= visibleTextLength(html0) * 1.3) {
      // rendering added nothing: keep the plain page with its working scripts
    } else {
      startHtml = r.html;
      startRendered = true;
      startOriginal = r.original;
      spaSite = trouble !== 'thin';
    }
    timings.browser = Date.now() - t;
  } else if (check.challenge) {
    throw new UserError(check.fatal, check.code);
  }
  const maxPages = spaSite ? CFG.siteMaxPagesBrowser : CFG.siteMaxPages;

  // ---- robots.txt and sitemap ----
  const tm = Date.now();
  onStatus(S.mapping);
  const robotsText = (CFG.siteRespectRobots || CFG.siteSitemap) ? await fetchText(`${start.origin}/robots.txt`, 8000, 200_000, opts.signal) : '';
  const robots = CFG.siteRespectRobots ? parseRobots(robotsText) : [];
  const seeds = CFG.siteSitemap ? await readSitemaps(start, robotsText, scope, opts.signal) : [];
  timings.map = Date.now() - tm;
  job.throwIfCancelled();

  // ---- one page of the crawl, with a per-page decision about the browser ----
  const getPage = async (url) => {
    if (spaSite && browserBudget > 0) { // this site builds every page with JavaScript: skip the pointless plain fetch
      const r = await tryBrowser(url);
      return r.fail ? { fail: r.fail } : { ...r, rendered: true };
    }
    const got = await fetchHtml(url, { signal: opts.signal });
    if (got.fail) {
      // refused to a plain request: a real browser may still get in
      if ([403, 429, 503].includes(got.status) && browserOn && browserBudget > 0) {
        const r = await tryBrowser(url);
        if (!r.fail) return { ...r, rendered: true };
      }
      return got;
    }
    const walled = isChallengeHtml(got.html) || isBotWallHtml(got.html);
    if (walled || looksLikeSpa(got.html)) {
      const r = await tryBrowser(url);
      if (!r.fail) return { ...r, rendered: true };
      return walled ? { fail: 'blocked by bot protection', status: 403 } : got;
    }
    if (browserOn && browserBudget > 0 && thinMisses < 3 && looksThin(got.html)) {
      const r = await tryBrowser(url);
      if (!r.fail && visibleTextLength(r.html) > visibleTextLength(got.html) * 1.3) return { ...r, rendered: true };
      thinMisses++;
    }
    return got;
  };

  // ---- breadth-first crawl of every page inside the scope ----
  const startKey = pageKey(start.href);
  const pages = new Map(); // key -> { key, base, html, local, rendered, fetchUrl, etag, lastModified, hash }
  pages.set(startKey, {
    key: startKey, base: start.href, html: startHtml, local: pageLocal(startKey), rendered: startRendered,
    fetchUrl: first.finalUrl, etag: first.headers?.get?.('etag') || null, lastModified: first.headers?.get?.('last-modified') || null, hash: hashOf(html0),
  });
  const seen = new Set([startKey]);
  const fileLinks = new Set();
  let accepted = 1;
  let loginSkipped = 0;
  let frontier = [startKey];
  const tc = Date.now();
  const enqueue = (link, next) => {
    if (seen.has(link)) return;
    seen.add(link);
    if (!robotsAllows(robots, link.slice(link.indexOf('/')))) {
      job.skipped.push({ url: `${start.protocol}//${link}`, reason: 'blocked by robots.txt' });
      return;
    }
    if (accepted >= maxPages) {
      job.skipped.push({ url: `${start.protocol}//${link}`, reason: `page limit (${maxPages}) reached` });
      return;
    }
    accepted++;
    next.push(link);
  };
  for (let depth = 0; frontier.length && !job.expired(); depth++) {
    const next = [];
    if (depth === 0) for (const k of seeds) enqueue(k, next);
    await pool(frontier, CFG.pageConcurrency, async (key) => {
      if (job.expired()) return;
      let page = pages.get(key);
      if (!page) {
        const url = `${start.protocol}//${key}`;
        const got = await getPage(url);
        if (got.fail) { job.failed.push({ url, reason: got.fail }); return; }
        const fin = new URL(got.finalUrl);
        if (fin.host !== scope.host) { job.skipped.push({ url: got.finalUrl, reason: 'redirected to another site' }); return; }
        if (LOGIN_PATH.test(fin.pathname) && !LOGIN_PATH.test(new URL(url).pathname)) {
          loginSkipped++;
          job.skipped.push({ url, reason: 'needs sign-in' });
          return;
        }
        page = {
          key, base: got.finalUrl, html: got.html, local: pageLocal(key), rendered: !!got.rendered,
          fetchUrl: url, etag: got.etag || null, lastModified: got.lastModified || null, hash: got.rendered ? null : hashOf(got.html),
        };
        pages.set(key, page);
        onStatus(S.pages(pages.size, accepted));
      }
      const hrefs = hrefsOf(cheerio.load(page.html));
      for (const f of fileLinksFromHrefs(hrefs, page.base, scope.host)) if (fileLinks.size < CFG.siteMaxFiles) fileLinks.add(f);
      if (depth >= CFG.siteDepth) return;
      for (const link of pageLinksFromHrefs(hrefs, page.base, scope)) enqueue(link, next);
    });
    frontier = next;
  }
  job.throwIfCancelled();
  timings.crawl = Date.now() - tc;
  const pageLimitHit = job.skipped.filter((s) => s.reason.startsWith('page limit')).length;
  const robotsBlocked = job.skipped.filter((s) => s.reason === 'blocked by robots.txt').length;

  // ---- every asset of every page, plus linked documents, downloaded once and shared ----
  for (const p of pages.values()) job.used.add(p.local.toLowerCase());
  const ta = Date.now();
  onStatus(S.assets());
  let lastEmit = 0;
  job.onProgress = (done, total) => {
    const n = Date.now();
    if (n - lastEmit > 1200 && done < total) { lastEmit = n; onStatus(S.assets(done, total)); }
  };
  const docs = [...pages.values()].map((p) => ({ html: p.html, base: p.base }));
  if (startOriginal) docs.push({ html: startOriginal, base: start.href });
  await collectAssets(job, docs, start.href, [...fileLinks]);
  job.throwIfCancelled();
  await rewriteCssFiles(job);
  timings.assets = Date.now() - ta;
  const tb = Date.now();

  // ---- smart size budgeting: shrink images BEFORE leaving anything out ----
  const startPage = pages.get(startKey);
  const pageRecs = [...pages.values()].map((p) => ({ url: p.base, local: p.local, type: 'text/html', size: bytesOf(p.html), page: p }));
  const startRec = pageRecs.find((r) => r.page === startPage);
  const totalEstimate = () => pageRecs.reduce((n, f) => n + estimate(f), 0) + [...job.files.values()].reduce((n, f) => n + estimate(f), 0);
  const capacityTotal = (CFG.partBytes - MB) * CFG.siteMaxParts;
  if (CFG.compressImages && totalEstimate() > capacityTotal) {
    const r = await compressImages(job, { needBytes: totalEstimate() - capacityTotal * 0.97 });
    if (r.count) warnings.push({ c: 'compressed', n: r.count });
  }

  // decide what fits in the ZIP parts BEFORE rewriting links, so anything left out keeps its live URL
  const { bins, overflow } = packPrioritized(
    [...pageRecs.filter((r) => r !== startRec), ...job.files.values()],
    { capacity: CFG.partBytes - MB, maxParts: CFG.siteMaxParts, weigh: estimate, rankOf: rank, pinned: [startRec] },
  );
  for (const f of overflow) {
    if (f.page) { pages.delete(f.page.key); }
    else { await fs.rm(path.join(siteDir, f.local), { force: true }); job.files.delete(f.url); job.totalBytes -= f.size; }
    job.skipped.push({ url: f.url, reason: `did not fit in ${CFG.siteMaxParts} ZIP parts`, size: f.size });
  }
  if (overflow.length) warnings.push({ c: 'overflow', n: overflow.length });

  // ---- wire everything: pages, assets and linked documents point to local paths; the rest keeps its live URL ----
  const pageLookup = (abs) => {
    try {
      if (new URL(abs).search) return undefined;
      return pages.get(pageKey(abs))?.local ?? job.files.get(abs)?.local;
    } catch { return undefined; }
  };
  const writeFailed = new Set();
  for (const p of pages.values()) {
    const out = rewriteHtml(cheerio.load(p.html), p.base, job.files, { from: p.local, pageLookup, stripScripts: p.rendered });
    const full = path.join(siteDir, p.local);
    try {
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, out);
    } catch (e) {
      writeFailed.add(p.local);
      job.failed.push({ url: p.base, reason: `could not save page (${e.message})` });
    }
  }
  const extraEntries = []; // small generated files that live in part 1
  const title = titleOf(startHtml);
  if (startPage.local !== 'index.html') {
    const rel = relPath('index.html', startPage.local);
    extraEntries.push({ name: 'index.html', pin: true, text: `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${escapeHtml(rel)}"><title>${escapeHtml(title || job.main.host)}</title><a href="${escapeHtml(rel)}">Open ${escapeHtml(job.main.host)}</a>\n` });
  }
  if (startOriginal) {
    const orig = rewriteHtml(cheerio.load(startOriginal), start.href, job.files, { from: 'index.original.html' });
    await fs.writeFile(path.join(siteDir, 'index.original.html'), orig);
    extraEntries.push({ name: 'index.original.html', pin: true, file: path.join(siteDir, 'index.original.html') });
  }
  // a local table of contents: every saved page in one list (handy for sites whose own menu needs JavaScript)
  const saved = [...pages.values()].filter((p) => !writeFailed.has(p.local)).sort((a, b) => a.local.localeCompare(b.local));
  if (saved.length > 1) {
    const rows = saved.map((p) => `<li><a href="${escapeHtml(relPath('_all-pages.html', p.local))}">${escapeHtml(titleOf(p.html) || p.local)}</a> <small>${escapeHtml(p.local)}</small></li>`).join('\n');
    extraEntries.push({
      name: '_all-pages.html', pin: true,
      text: `<!doctype html>\n<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${escapeHtml(job.main.host)} - all pages</title>\n<style>body{font:16px system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}li{margin:.35rem 0}small{color:#777;margin-left:.4rem;word-break:break-all}</style>\n<h1>${escapeHtml(job.main.host)}</h1>\n<p>${saved.length} saved pages</p>\n<ul>\n${rows}\n</ul>\n`,
    });
  }

  // ---- verify before sending: every local link must point to a file that is really in the ZIPs ----
  onStatus(S.checking);
  for (const b of bins) b.files = b.files.filter((f) => !writeFailed.has(f.local));
  let linkStats = null;
  if (CFG.linkCheck) {
    const entrySet = new Set([...bins.flatMap((b) => b.files.map((f) => f.local)), ...extraEntries.map((e) => e.name), 'readme.txt', 'skipped.txt'].map((x) => x.toLowerCase()));
    const live = new Map();
    for (const f of job.files.values()) live.set(f.local.toLowerCase(), f.url);
    for (const p of pages.values()) live.set(p.local.toLowerCase(), p.base);
    linkStats = await checkLinks({ dir: siteDir, pages: saved, entries: entrySet, liveUrlFor: (local) => live.get(local.toLowerCase()) });
    if (linkStats.fixed || linkStats.broken) console.log(`[linkcheck] ${job.main.host}: ${linkStats.checked} checked, ${linkStats.fixed} repaired, ${linkStats.broken} unresolved`);
  }

  if (loginSkipped) warnings.push({ c: 'loginPages', n: loginSkipped });
  if (pageLimitHit) warnings.push({ c: 'pageLimit', n: maxPages });
  if (robotsBlocked) warnings.push({ c: 'robots', n: robotsBlocked });
  if (job.timedOut) warnings.push({ c: 'slow' });
  timings.build = Date.now() - tb;

  // ---- pack into ZIP parts: all parts unzip into the same folder, and every link is relative to that folder ----
  t = Date.now();
  onStatus(S.zip);
  const anyRendered = [...pages.values()].some((p) => p.rendered);
  const skipText = skippedText(job);
  const scopeLabel = `${job.main.host}${scope.path === '/' ? '' : scope.path}`;
  const readme = [
    `Website Downloader - offline copy of ${scopeLabel}`,
    `Saved: ${new Date().toISOString()}`,
    '',
    'HOW TO OPEN: double-click index.html',
    'If this copy came as several ZIP files (part1of3, part2of3, ...), unzip ALL of them into the same folder first (merge when asked).',
    '',
    'Notes:',
    `- ${pages.size} page${pages.size === 1 ? '' : 's'} saved. Links between saved pages, images, styles and documents work offline; anything else opens the live site.`,
    ...(saved.length > 1 ? ['- _all-pages.html lists every saved page in one place.'] : []),
    "- Sign-ins, forms, search and live data need the site's server and won't work offline.",
    '- Links with search filters (?page=2) are not followed.',
    '- If a page looks broken when opened directly, run "npx serve" inside the folder and open the address it shows.',
    ...(anyRendered ? ['- Pages that need JavaScript were captured the way a browser shows them, so their scripts were removed and they open with a double-click.'] : []),
    ...(startOriginal ? ["- index.original.html keeps the home page's interactive features (needs npx serve)."] : []),
    ...(skipText ? ['- See skipped.txt for files that were left out.'] : []),
  ].join('\n') + '\n';

  const entryOf = (f) => ({ name: f.local, file: path.join(siteDir, f.local), size: f.size });
  const work = bins.map((b, i) => ({
    entries: [
      ...b.files.map(entryOf),
      ...(i === 0
        ? [...extraEntries, { name: 'README.txt', text: readme }, ...(skipText ? [{ name: 'skipped.txt', text: skipText }] : [])]
          .map((e) => ({ ...e, size: e.text ? bytesOf(e.text) : 1000 }))
        : []),
    ],
  }));
  const startEntry = work[0].entries.find((e) => e.name === startRec.local && !e.text);
  if (startEntry) startEntry.pin = true;

  // zip; if a part still lands over Telegram's limit (poorly compressible content), split it in two
  const made = [];
  let seq = 0;
  while (work.length) {
    job.throwIfCancelled();
    const bin = work.shift();
    const zipPath = path.join(workDir, `part-${seq++}.zip`);
    await zipEntries(zipPath, bin.entries);
    const { size } = await fs.stat(zipPath);
    if (size > TG_MAX_BYTES) {
      await fs.rm(zipPath, { force: true });
      if (bin.entries.length < 2)
        throw new UserError(`📦 A single file came out at ${mb(size)} MB, over Telegram's limit.`, 'zip_too_big');
      const pinned = bin.entries.filter((e) => e.pin);
      const rest = bin.entries.filter((e) => !e.pin).sort((a, b) => b.size - a.size);
      const A = [...pinned]; const B = [];
      let sa = A.reduce((n, e) => n + e.size, 0); let sb = 0;
      for (const e of rest) { if (sa <= sb) { A.push(e); sa += e.size; } else { B.push(e); sb += e.size; } }
      work.unshift({ entries: A }, ...(B.length ? [{ entries: B }] : []));
      continue;
    }
    made.push({ zipPath, bytes: size, entries: bin.entries });
  }
  const n = made.length;
  const baseName = hostFile(job);
  const parts = made.map((m, i) => ({ zipPath: m.zipPath, zipName: n > 1 ? `${baseName}-part${i + 1}of${n}.zip` : `${baseName}.zip`, bytes: m.bytes }));
  timings.zip = Date.now() - t;
  const zipBytes = parts.reduce((s, p) => s + p.bytes, 0);

  // what a later "Fresh copy" compares against (only plain pages can be checked cheaply)
  const fingerprint = anyRendered
    ? null
    : [...pages.values()].filter((p) => p.hash).map((p) => ({ u: p.fetchUrl, e: p.etag, m: p.lastModified, h: p.hash }));

  return {
    kind: 'pages', parts, host: job.main.host, title,
    pages: pages.size, fileCount: job.files.size + pages.size, zipBytes,
    mode: anyRendered ? 'site-browser' : 'site-pages', warnings, skipped: job.skipped.length, failed: job.failed.length,
    timings, fingerprint, linkCheck: linkStats,
  };
}

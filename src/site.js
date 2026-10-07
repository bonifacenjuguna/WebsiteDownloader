import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { CFG, MB, TG_MAX_BYTES, mb } from './config.js';
import { UserError } from './errors.js';
import { safeFetch, readBody } from './net.js';
import { Job } from './job.js';
import { analyze, looksLikeSpa, isChallengeHtml } from './analyze.js';
import { decodeBody, rewriteHtml, relPath } from './extract.js';
import { collectAssets, rewriteCssFiles, fetchAsset, pool } from './assets.js';
import { rank, estimate } from './trim.js';
import { renderWithBrowser, browserSem } from './browser.js';
import { zipEntries } from './zip.js';
import { fetchMain } from './downloader.js';
import { STATUS, NOTES } from './copy.js';
import {
  parseRobots, robotsAllows, pageKey, pageLocal, scopePathOf, pageLinksFromHrefs,
  isListingTitle, classifyListingHrefs, listingLocal, packParts, packPrioritized, fileLinksFromHrefs, listingIndexHtml, escapeHtml,
} from './site-util.js';

const hrefsOf = ($) => { const out = []; $('a[href]').each((_, el) => out.push($(el).attr('href'))); return out; };
const titleOf = (html) => cheerio.load(html)('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 80);

async function fetchHtml(url) {
  try {
    const { res, url: finalUrl } = await safeFetch(url, {
      timeoutMs: 20000,
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || (type && !/html/i.test(type))) {
      res.body?.cancel().catch(() => {});
      return { fail: res.ok ? 'not an HTML page' : `HTTP ${res.status}` };
    }
    const body = await readBody(res, CFG.maxHtmlBytes);
    if (body.tooBig) return { fail: 'page too large' };
    return { html: decodeBody(body.buf, type), finalUrl: finalUrl.href };
  } catch (e) {
    return { fail: e?.message || 'error' };
  }
}

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
  block('SKIPPED (limits, size or robots.txt):', job.skipped, (s) => `${s.url} - ${s.reason}${s.size ? ` (${mb(s.size)} MB)` : ''}`);
  block('COULD NOT BE DOWNLOADED:', job.failed, (f) => `${f.url} - ${f.reason}`);
  if (job.timedOut) lines.push('', 'NOTE: the time limit was reached, so the result is incomplete.');
  return lines.length ? `${lines.join('\n')}\n` : '';
}

const hostFile = (job) => job.main.hostname.replace(/[^a-z0-9.-]/gi, '_');

// ---------------------------------------------------------------- entry point
// One entry for everything: a folder listing is downloaded as files, anything else is crawled as a whole site
// (or, when the link points deeper than the home page, as that part of the site).
export async function downloadWebsite(parsed, workDir, onStatus = () => {}, opts = {}) {
  if (opts.forceBrowser && !CFG.enableBrowser)
    throw new UserError('🧭 Browser mode is disabled on this bot.', 'browser_disabled');
  const timings = {};
  const siteDir = path.join(workDir, 'site');
  await fs.mkdir(siteDir, { recursive: true });

  let t = Date.now();
  onStatus(STATUS.opening(parsed.url.host));
  const first = await fetchMain(parsed.url, parsed.explicitScheme);
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
  if (check.challenge && !CFG.enableBrowser) throw new UserError(check.fatal, 'cloudflare');

  const $ = cheerio.load(html0);
  const listing = !check.challenge && !opts.forceBrowser && isListingTitle($('title').first().text(), $('h1').first().text());
  const c = { first, html0, workDir, siteDir, onStatus, timings, warnings: [...check.warnings], check, opts };
  return listing ? runListing(c) : runWebsite(c);
}

// ---------------------------------------------------------------- open folder listing
async function runListing({ first, html0, workDir, siteDir, onStatus, timings, warnings }) {
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
      const got = await fetchHtml(d.url);
      if (got.fail) { job.failed.push({ url: d.url, reason: `could not read folder (${got.fail})` }); continue; }
      html = got.html;
    }
    const $ = cheerio.load(html);
    if (d.depth > 0 && !isListingTitle($('title').first().text(), $('h1').first().text())) {
      job.failed.push({ url: d.url, reason: 'not a folder listing' });
      continue;
    }
    scanned++;
    onStatus(STATUS.folders(scanned, fileUrls.size));
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

  let list = [...fileUrls];
  if (list.length > CFG.siteMaxFiles) {
    for (const u of list.slice(CFG.siteMaxFiles)) job.skipped.push({ url: u, reason: `file limit (${CFG.siteMaxFiles}) reached` });
    list = list.slice(0, CFG.siteMaxFiles);
  }
  if (!list.length)
    throw new UserError("📂 That folder listing has no files I can download.", 'empty_listing');

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
      onStatus(STATUS.files(job.progress.done, job.progress.total));
    }
  });
  timings.assets = Date.now() - t;
  if (!job.files.size)
    throw new UserError(`📂 I couldn't download any files from that folder (each must be under ${mb(CFG.maxFileBytes)} MB). See the reasons with a smaller folder.`, 'listing_unsavable');

  // 3) pack into Telegram-sized ZIP parts
  t = Date.now();
  onStatus(STATUS.zip);
  const { bins, overflow } = packParts([...job.files.values()], PART, CFG.siteMaxParts);
  for (const f of overflow) {
    job.files.delete(f.url);
    job.skipped.push({ url: f.url, reason: `did not fit in ${CFG.siteMaxParts} ZIP parts`, size: f.size });
  }
  if (overflow.length) warnings.push(NOTES.overflow(overflow.length));

  const n = bins.length;
  const skipText = skippedText(job);
  const parts = [];
  for (let i = 0; i < n; i++) {
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
  if (job.timedOut) warnings.push(NOTES.slow);

  return {
    kind: 'listing', parts, host: job.main.host, title: rootPath,
    dirCount: dirsSeen.size, fileCount: job.files.size,
    zipBytes: parts.reduce((s, p) => s + p.bytes, 0),
    mode: 'site-files', warnings, skipped: job.skipped.length, failed: job.failed.length, timings, thin: false,
  };
}

// ---------------------------------------------------------------- a whole website (or a part of one)
const bytesOf = (str) => Buffer.byteLength(str, 'utf8');

async function runWebsite({ first, html0, workDir, siteDir, onStatus, timings, warnings, check, opts }) {
  const start = new URL(first.finalUrl);
  start.hash = '';
  const scope = { host: start.host, path: scopePathOf(start.pathname) }; // "/" = the whole site
  const job = new Job(siteDir, start.href, {
    timeoutMs: CFG.siteTimeoutMs,
    maxTotalBytes: CFG.siteMaxTotalBytes,
    maxFiles: 5000,
    fetchTimeoutMs: 60000, // big files need time
  });

  // static fetch by default; a real browser for JavaScript-built sites, challenges and /browser
  let useBrowser = CFG.enableBrowser && (opts.forceBrowser || check.challenge || looksLikeSpa(html0));
  const getBrowserPage = async (url) => {
    try {
      const r = await browserSem.run(() => renderWithBrowser(job, url));
      if (isChallengeHtml(r.html)) return { fail: 'challenge' };
      return { html: r.html, finalUrl: r.finalUrl, original: r.originalHtml };
    } catch (e) { return { fail: e?.message || 'browser error' }; }
  };
  const getPage = (url) => (useBrowser ? getBrowserPage(url) : fetchHtml(url));

  let t = Date.now();
  let startHtml = html0;
  let startOriginal = null;
  if (useBrowser) {
    onStatus(STATUS.browser);
    const r = await getBrowserPage(first.finalUrl);
    if (r.fail === 'challenge') throw new UserError('cloudflare challenge', 'cloudflare');
    if (r.fail) {
      if (check.challenge) throw new UserError('cloudflare challenge', 'cloudflare');
      if (opts.forceBrowser) throw new UserError(`browser mode failed: ${r.fail}`, 'browser_failed');
      useBrowser = false;
      warnings.push(NOTES.browserFallback);
    } else {
      startHtml = r.html;
      startOriginal = r.original;
    }
  }
  const maxPages = useBrowser ? CFG.siteMaxPagesBrowser : CFG.siteMaxPages;

  let robots = [];
  if (CFG.siteRespectRobots) {
    const got = await safeFetch(`${start.origin}/robots.txt`, { timeoutMs: 8000 }).then(async ({ res }) => {
      if (!res.ok) { res.body?.cancel().catch(() => {}); return ''; }
      const b = await readBody(res, 200_000);
      return b.tooBig ? '' : b.buf.toString('utf8');
    }).catch(() => '');
    robots = parseRobots(got);
  }

  // breadth-first crawl of every page inside the scope
  const startKey = pageKey(start.href);
  const pages = new Map(); // key -> { key, base, html, local }
  pages.set(startKey, { key: startKey, base: start.href, html: startHtml, local: pageLocal(startKey) });
  const seen = new Set([startKey]);
  const fileLinks = new Set();
  let accepted = 1;
  let frontier = [startKey];
  for (let depth = 0; frontier.length && !job.expired(); depth++) {
    const next = [];
    await pool(frontier, useBrowser ? CFG.browserConcurrency : 4, async (key) => {
      if (job.expired()) return;
      let page = pages.get(key);
      if (!page) {
        const url = `${start.protocol}//${key}`;
        const got = await getPage(url);
        if (got.fail) { job.failed.push({ url, reason: got.fail }); return; }
        if (new URL(got.finalUrl).host !== scope.host) { job.skipped.push({ url: got.finalUrl, reason: 'redirected to another site' }); return; }
        page = { key, base: got.finalUrl, html: got.html, local: pageLocal(key) };
        pages.set(key, page);
        onStatus(STATUS.pages(pages.size, accepted));
      }
      const $p = cheerio.load(page.html);
      const hrefs = hrefsOf($p);
      for (const f of fileLinksFromHrefs(hrefs, page.base, scope.host)) if (fileLinks.size < CFG.siteMaxFiles) fileLinks.add(f);
      if (depth >= CFG.siteDepth) return;
      for (const link of pageLinksFromHrefs(hrefs, page.base, scope)) {
        if (seen.has(link)) continue;
        seen.add(link);
        if (!robotsAllows(robots, link.slice(link.indexOf('/')))) {
          job.skipped.push({ url: `${start.protocol}//${link}`, reason: 'blocked by robots.txt' });
          continue;
        }
        if (accepted >= maxPages) {
          job.skipped.push({ url: `${start.protocol}//${link}`, reason: `page limit (${maxPages}) reached` });
          continue;
        }
        accepted++;
        next.push(link);
      }
    });
    frontier = next;
  }
  const pageLimitHit = job.skipped.filter((s) => s.reason.startsWith('page limit')).length;
  const robotsBlocked = job.skipped.filter((s) => s.reason === 'blocked by robots.txt').length;

  // every asset of every page, plus linked documents, downloaded once and shared
  for (const p of pages.values()) job.used.add(p.local.toLowerCase());
  onStatus(STATUS.assets());
  let lastEmit = 0;
  job.onProgress = (done, total) => {
    const n = Date.now();
    if (n - lastEmit > 1200 && done < total) { lastEmit = n; onStatus(STATUS.assets(done, total)); }
  };
  const docs = [...pages.values()].map((p) => ({ html: p.html, base: p.base }));
  if (startOriginal) docs.push({ html: startOriginal, base: start.href });
  await collectAssets(job, docs, start.href, [...fileLinks]);
  await rewriteCssFiles(job);

  // decide what fits in the ZIP parts BEFORE rewriting links, so anything left out keeps its live URL
  const startPage = pages.get(startKey);
  const pageRecs = [...pages.values()].map((p) => ({ url: p.base, local: p.local, type: 'text/html', size: bytesOf(p.html), page: p }));
  const startRec = pageRecs.find((r) => r.page === startPage);
  const { bins, overflow } = packPrioritized(
    [...pageRecs.filter((r) => r !== startRec), ...job.files.values()],
    { capacity: CFG.partBytes - MB, maxParts: CFG.siteMaxParts, weigh: estimate, rankOf: rank, pinned: [startRec] },
  );
  for (const f of overflow) {
    if (f.page) { pages.delete(f.page.key); }
    else { await fs.rm(path.join(siteDir, f.local), { force: true }); job.files.delete(f.url); job.totalBytes -= f.size; }
    job.skipped.push({ url: f.url, reason: `did not fit in ${CFG.siteMaxParts} ZIP parts`, size: f.size });
  }
  if (overflow.length) warnings.push(NOTES.overflow(overflow.length));

  // wire everything: pages, assets and linked documents point to local paths; the rest keeps its live URL
  const pageLookup = (abs) => {
    try {
      if (new URL(abs).search) return undefined;
      return pages.get(pageKey(abs))?.local ?? job.files.get(abs)?.local;
    } catch { return undefined; }
  };
  for (const p of pages.values()) {
    const out = rewriteHtml(cheerio.load(p.html), p.base, job.files, { from: p.local, pageLookup, stripScripts: useBrowser });
    const full = path.join(siteDir, p.local);
    try {
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, out);
    } catch (e) {
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

  if (pageLimitHit) warnings.push(NOTES.pageLimit(maxPages));
  if (robotsBlocked) warnings.push(NOTES.robots(robotsBlocked));
  if (job.timedOut) warnings.push(NOTES.slow);
  timings.assets = Date.now() - t;

  // ---- pack into ZIP parts: all parts unzip into the same folder, and every link is relative to that folder
  t = Date.now();
  onStatus(STATUS.zip);
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
    "- Sign-ins, forms, search and live data need the site's server and won't work offline.",
    '- Links with search filters (?page=2) are not followed.',
    '- If a page looks broken when opened directly, run "npx serve" inside the folder and open the address it shows.',
    ...(useBrowser ? ['- Pages were captured the way a browser shows them, so scripts were removed and index.html opens with a double-click.'] : []),
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
  work[0].entries.find((e) => e.name === startRec.local && !e.text).pin = true;

  // zip; if a part still lands over Telegram's limit (poorly compressible content), split it in two
  const made = [];
  let seq = 0;
  while (work.length) {
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
  const base = hostFile(job);
  const parts = made.map((m, i) => ({ zipPath: m.zipPath, zipName: n > 1 ? `${base}-part${i + 1}of${n}.zip` : `${base}.zip`, bytes: m.bytes }));
  timings.zip = Date.now() - t;
  const zipBytes = parts.reduce((s, p) => s + p.bytes, 0);

  return {
    kind: 'pages', parts, host: job.main.host, title,
    pages: pages.size, fileCount: job.files.size + pages.size, zipBytes,
    mode: useBrowser ? 'site-browser' : 'site-pages', warnings, skipped: job.skipped.length, failed: job.failed.length, timings, thin: false,
  };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { CFG, MB, TG_MAX_BYTES, TG_TARGET_BYTES, mb } from './config.js';
import { UserError } from './errors.js';
import { safeFetch, readBody } from './net.js';
import { Job } from './job.js';
import { analyze, looksLikeSpa } from './analyze.js';
import { decodeBody, rewriteHtml, relPath } from './extract.js';
import { collectAssets, rewriteCssFiles, fetchAsset, pool } from './assets.js';
import { trimToBudget } from './trim.js';
import { zipEntries, zipDir } from './zip.js';
import { fetchMain } from './downloader.js';
import {
  parseRobots, robotsAllows, pageKey, pageLocal, scopePathOf, pageLinksFromHrefs,
  isListingTitle, classifyListingHrefs, listingLocal, packParts, listingIndexHtml, escapeHtml,
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
export async function downloadSection(parsed, workDir, onStatus = () => {}) {
  const timings = {};
  const siteDir = path.join(workDir, 'site');
  await fs.mkdir(siteDir, { recursive: true });

  let t = Date.now();
  onStatus(`🌐 Fetching ${parsed.url.host}…`);
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
  if (check.fatal) throw new UserError(check.fatal, check.code);

  const $ = cheerio.load(html0);
  const listing = isListingTitle($('title').first().text(), $('h1').first().text());
  const c = { first, html0, workDir, siteDir, onStatus, timings, warnings: [...check.warnings] };
  return listing ? runListing(c) : runPages(c);
}

// ---------------------------------------------------------------- open folder listing
async function runListing({ first, html0, workDir, siteDir, onStatus, timings, warnings }) {
  const PART = TG_TARGET_BYTES - MB; // room for index/readme inside each ZIP
  const start = new URL(first.finalUrl);
  start.search = '';
  start.hash = '';
  if (!start.pathname.endsWith('/')) start.pathname += '/';
  const rootPath = start.pathname;

  const job = new Job(siteDir, start.href, {
    maxFiles: CFG.siteMaxFiles,
    maxTotalBytes: Math.min(CFG.siteMaxTotalBytes, CFG.siteMaxParts * PART),
    maxFileBytes: PART,
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
    onStatus(`📂 Scanning folders… (${scanned} folders, ${fileUrls.size} files)`);
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
      onStatus(`📥 Files ${job.progress.done}/${job.progress.total}…`);
    }
  });
  timings.assets = Date.now() - t;
  if (!job.files.size)
    throw new UserError(`📂 I couldn't download any files from that folder (each must be under ${mb(PART)} MB). See the reasons with a smaller folder.`, 'empty_listing');

  // 3) pack into Telegram-sized ZIP parts
  t = Date.now();
  onStatus('🗜️ Creating ZIP…');
  const { bins, overflow } = packParts([...job.files.values()], PART, CFG.siteMaxParts);
  for (const f of overflow) {
    job.files.delete(f.url);
    job.skipped.push({ url: f.url, reason: `did not fit in ${CFG.siteMaxParts} ZIP parts`, size: f.size });
  }
  if (overflow.length) warnings.push(`📦 ${overflow.length} file${overflow.length > 1 ? 's' : ''} didn't fit in ${CFG.siteMaxParts} ZIP parts (see skipped.txt).`);

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
  if (job.timedOut) warnings.push('⏱️ Time limit reached, so the result is incomplete.');

  return {
    kind: 'listing', parts, host: job.main.host, title: rootPath,
    dirCount: dirsSeen.size, fileCount: job.files.size,
    zipBytes: parts.reduce((s, p) => s + p.bytes, 0),
    mode: 'site-files', warnings, skipped: job.skipped.length, failed: job.failed.length, timings, thin: false,
  };
}

// ---------------------------------------------------------------- a section of pages
async function runPages({ first, html0, workDir, siteDir, onStatus, timings, warnings }) {
  if (looksLikeSpa(html0))
    throw new UserError("🧭 This site builds its pages with JavaScript, so I can't follow its links reliably. Use /browser <url> to save the page itself.", 'spa_section');

  const start = new URL(first.finalUrl);
  start.hash = '';
  const scope = { host: start.host, path: scopePathOf(start.pathname) };
  const job = new Job(siteDir, start.href, { timeoutMs: CFG.siteTimeoutMs });

  let t = Date.now();
  let robots = [];
  if (CFG.siteRespectRobots) {
    const got = await safeFetch(`${start.origin}/robots.txt`, { timeoutMs: 8000 }).then(async ({ res }) => {
      if (!res.ok) { res.body?.cancel().catch(() => {}); return ''; }
      const b = await readBody(res, 200_000);
      return b.tooBig ? '' : b.buf.toString('utf8');
    }).catch(() => '');
    robots = parseRobots(got);
  }

  // breadth-first crawl, capped by pages and depth
  const startKey = pageKey(start.href);
  const pages = new Map(); // key -> { key, base, html, local }
  pages.set(startKey, { key: startKey, base: start.href, html: html0, local: pageLocal(startKey) });
  const seen = new Set([startKey]);
  let accepted = 1;
  let frontier = [startKey];
  for (let depth = 0; frontier.length && !job.expired(); depth++) {
    const next = [];
    await pool(frontier, 4, async (key) => {
      if (job.expired()) return;
      let page = pages.get(key);
      if (!page) {
        const got = await fetchHtml(`${start.protocol}//${key}`);
        if (got.fail) { job.failed.push({ url: `${start.protocol}//${key}`, reason: got.fail }); return; }
        if (new URL(got.finalUrl).host !== scope.host) { job.skipped.push({ url: got.finalUrl, reason: 'redirected to another site' }); return; }
        page = { key, base: got.finalUrl, html: got.html, local: pageLocal(key) };
        pages.set(key, page);
        onStatus(`📄 Pages ${pages.size}/${accepted}…`);
      }
      if (depth >= CFG.siteDepth) return;
      const $ = cheerio.load(page.html);
      for (const link of pageLinksFromHrefs(hrefsOf($), page.base, scope)) {
        if (seen.has(link)) continue;
        seen.add(link);
        if (!robotsAllows(robots, link.slice(link.indexOf('/')))) {
          job.skipped.push({ url: `${start.protocol}//${link}`, reason: 'blocked by robots.txt' });
          continue;
        }
        if (accepted >= CFG.siteMaxPages) {
          job.skipped.push({ url: `${start.protocol}//${link}`, reason: `page limit (${CFG.siteMaxPages}) reached` });
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

  // download assets for all pages at once, then rewrite
  for (const p of pages.values()) job.used.add(p.local.toLowerCase());
  onStatus('📦 Downloading assets…');
  let lastEmit = 0;
  job.onProgress = (done, total) => {
    const n = Date.now();
    if (n - lastEmit > 1200 && done < total) { lastEmit = n; onStatus(`📦 Downloading assets ${done}/${total}…`); }
  };
  await collectAssets(job, [...pages.values()].map((p) => ({ html: p.html, base: p.base })));
  const trimmed = await trimToBudget(job);
  if (trimmed) warnings.push(`✂️ ${trimmed} large file${trimmed > 1 ? 's were' : ' was'} left out to fit Telegram's 50 MB limit (see skipped.txt).`);
  await rewriteCssFiles(job);

  const pageLookup = (abs) => {
    try {
      if (new URL(abs).search) return undefined;
      return pages.get(pageKey(abs))?.local;
    } catch { return undefined; }
  };
  for (const p of pages.values()) {
    const out = rewriteHtml(cheerio.load(p.html), p.base, job.files, { from: p.local, pageLookup });
    const full = path.join(siteDir, p.local);
    try {
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, out);
    } catch (e) {
      job.failed.push({ url: p.base, reason: `could not save page (${e.message})` });
    }
  }
  const startPage = pages.get(startKey);
  const title = titleOf(html0);
  if (startPage.local !== 'index.html') {
    const rel = relPath('index.html', startPage.local);
    await fs.writeFile(path.join(siteDir, 'index.html'),
      `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${escapeHtml(rel)}"><title>${escapeHtml(title || job.main.host)}</title><a href="${escapeHtml(rel)}">Open ${escapeHtml(job.main.host)}</a>\n`);
  }

  if (pageLimitHit) warnings.push(`📄 More pages were found than the ${CFG.siteMaxPages}-page limit (see skipped.txt).`);
  if (robotsBlocked) warnings.push(`🤖 ${robotsBlocked} page${robotsBlocked > 1 ? 's were' : ' was'} skipped because the site's robots.txt asks bots not to fetch them.`);
  if (job.timedOut) warnings.push('⏱️ Time limit reached, so the result is incomplete.');

  const skipText = skippedText(job);
  if (skipText) await fs.writeFile(path.join(siteDir, 'skipped.txt'), skipText);
  await fs.writeFile(path.join(siteDir, 'README.txt'), [
    `Website Downloader - section of ${job.main.host}${scope.path}`,
    `Saved: ${new Date().toISOString()}`,
    '',
    'HOW TO OPEN: double-click index.html',
    '',
    'Notes:',
    `- ${pages.size} page${pages.size === 1 ? '' : 's'} saved. Links between saved pages work offline; links to anything else open the live site.`,
    '- Links with query strings (?x=1) and non-page files like PDFs are not followed.',
    '- If a page looks broken when opened directly, run "npx serve" inside this folder.',
    ...(skipText ? ['- See skipped.txt for pages and files that were left out.'] : []),
  ].join('\n') + '\n');
  timings.assets = Date.now() - t;

  t = Date.now();
  onStatus('🗜️ Creating ZIP…');
  const zipName = `${hostFile(job)}-section.zip`;
  const zipPath = path.join(workDir, zipName);
  await zipDir(siteDir, zipPath);
  const { size } = await fs.stat(zipPath);
  timings.zip = Date.now() - t;
  if (size > TG_MAX_BYTES)
    throw new UserError(`📦 Even after leaving out media and images, this section comes to ${mb(size)} MB, over Telegram's 50 MB limit. Try a smaller section.`, 'zip_too_big');

  return {
    kind: 'pages', parts: [{ zipPath, zipName, bytes: size }], host: job.main.host, title,
    pages: pages.size, fileCount: job.files.size + pages.size, zipBytes: size,
    mode: 'site-pages', warnings, skipped: job.skipped.length, failed: job.failed.length, timings, thin: false,
  };
}

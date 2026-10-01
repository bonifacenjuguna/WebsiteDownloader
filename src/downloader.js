import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { CFG, TG_MAX_BYTES, mb } from './config.js';
import { UserError, explainNetError } from './errors.js';
import { safeFetch, readBody } from './net.js';
import { Job } from './job.js';
import { analyze, isChallengeHtml, looksLikeSpa, looksThin } from './analyze.js';
import { decodeBody, rewriteHtml } from './extract.js';
import { collectAssets, rewriteCssFiles } from './assets.js';
import { renderWithBrowser, browserSem } from './browser.js';
import { trimToBudget } from './trim.js';
import { zipDir } from './zip.js';

const cfMsg = (host) => `🛡️ ${host} is behind a Cloudflare challenge that blocks automated visitors. I tried a real browser too and it didn't get through.`;

async function fetchMain(url, explicitScheme) {
  const attempt = async (u) => {
    const { res, url: finalUrl } = await safeFetch(u.href, {
      timeoutMs: 20000,
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const body = await readBody(res, CFG.maxHtmlBytes);
    if (body.tooBig) throw new UserError('📏 That page is too large to process.', 'too_large');
    return {
      status: res.status,
      headers: res.headers,
      buf: body.buf,
      finalUrl: finalUrl.href,
      contentType: res.headers.get('content-type') || '',
    };
  };
  try {
    return await attempt(url);
  } catch (e) {
    // bare domain: https failed, try plain http
    if (!explicitScheme && url.protocol === 'https:' && !(e instanceof UserError)) {
      const alt = new URL(url.href);
      alt.protocol = 'http:';
      try { return await attempt(alt); } catch { /* report the original error */ }
    }
    throw explainNetError(e, url.host);
  }
}

async function writeInfoFiles(job, mode, sourceUrl) {
  const lines = [];
  if (job.skipped.length) {
    lines.push('SKIPPED (too large, trimmed or over limits):');
    for (const s of job.skipped) lines.push(`  ${s.url} - ${s.reason}${s.size ? ` (${mb(s.size)} MB)` : ''}`);
  }
  if (job.failed.length) {
    if (lines.length) lines.push('');
    lines.push('COULD NOT BE DOWNLOADED:');
    for (const f of job.failed) lines.push(`  ${f.url} - ${f.reason}`);
  }
  if (job.timedOut) lines.push('', 'NOTE: the time limit was reached, so some files may be missing.');
  if (lines.length) await fs.writeFile(path.join(job.dir, 'skipped.txt'), lines.join('\n') + '\n');

  const readme = [
    `Website Downloader - offline copy of ${sourceUrl}`,
    `Saved: ${new Date().toISOString()}`,
    '',
    'HOW TO OPEN: double-click index.html',
    '',
    'Notes:',
    '- Files that could not be downloaded keep their original online links.',
    '- Live API calls, logins and server-side features are not included.',
    '- If the page looks broken when opened directly, run "npx serve" inside this folder and open the address it prints.',
    ...(mode === 'browser'
      ? [
          '- index.html is a snapshot of the page after it finished rendering, with scripts removed so it opens reliably from disk.',
          '- index.original.html keeps the site\'s original scripts. Serve this folder with "npx serve" and open index.original.html to run the real app.',
        ]
      : []),
    ...(lines.length ? ['- See skipped.txt for files that were left out.'] : []),
  ].join('\n');
  await fs.writeFile(path.join(job.dir, 'README.txt'), readme + '\n');
}

export async function downloadSite(parsed, workDir, onStatus = () => {}, opts = {}) {
  if (opts.forceBrowser && !CFG.enableBrowser)
    throw new UserError('🧭 Browser mode is disabled on this bot.', 'browser_disabled');

  const timings = {};
  const lap = (name, t0) => { timings[name] = Date.now() - t0; };
  const siteDir = path.join(workDir, 'site');
  await fs.mkdir(siteDir, { recursive: true });

  let t = Date.now();
  onStatus(`🌐 Fetching ${parsed.url.host}…`);
  const first = await fetchMain(parsed.url, parsed.explicitScheme);
  lap('fetch', t);
  const isHtml = !first.contentType || /html/i.test(first.contentType);
  const html0 = isHtml ? decodeBody(first.buf, first.contentType) : '';

  if (first.status < 400 && !isHtml)
    throw new UserError(`📄 That link isn't a web page (it's ${first.contentType.split(';')[0]}). Send a page address instead.`, 'not_html');

  const check = analyze({
    status: first.status,
    headers: first.headers,
    html: html0,
    requestedUrl: parsed.url.href,
    finalUrl: first.finalUrl,
    isHtml,
  });
  if (check.fatal && !check.challenge) throw new UserError(check.fatal, check.code);

  const job = new Job(siteDir, first.finalUrl);
  const warnings = [...check.warnings];
  let mode = 'fast';
  let rendered = null;

  const wantBrowser = CFG.enableBrowser && (opts.forceBrowser || check.challenge || looksLikeSpa(html0));
  if (wantBrowser) {
    t = Date.now();
    try {
      onStatus('🧭 Loading it in a headless browser…');
      rendered = await browserSem.run(() => renderWithBrowser(job, first.finalUrl));
      if (isChallengeHtml(rendered.html)) throw new UserError(cfMsg(job.main.host), 'cloudflare');
      mode = 'browser';
      lap('browser', t);
    } catch (e) {
      if (e instanceof UserError) throw e;
      console.error('browser mode failed:', e?.message);
      if (check.challenge) throw new UserError(cfMsg(job.main.host), 'cloudflare');
      if (opts.forceBrowser) throw new UserError('🧭 Browser mode failed on this site. Try again later, or send the link normally.', 'browser_failed');
      rendered = null;
      warnings.push('⚠️ The headless browser failed, so I saved the static HTML only.');
    }
  } else if (check.challenge) {
    throw new UserError(check.fatal, 'cloudflare');
  }

  const base = rendered ? rendered.finalUrl : first.finalUrl;
  const original = (rendered && rendered.originalHtml) || html0;
  const docs = rendered ? [rendered.html, original] : [html0];
  const title = cheerio.load(rendered ? rendered.html : html0)('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 80);

  t = Date.now();
  onStatus('📦 Downloading assets…');
  let lastEmit = 0;
  job.onProgress = (done, total) => {
    const n = Date.now();
    if (n - lastEmit > 1200 && done < total) { lastEmit = n; onStatus(`📦 Downloading assets ${done}/${total}…`); }
  };
  await collectAssets(job, docs, base);

  // too heavy for Telegram? drop the biggest media/images instead of failing
  const trimmed = await trimToBudget(job);
  if (trimmed) warnings.push(`✂️ ${trimmed} large file${trimmed > 1 ? 's were' : ' was'} left out to fit Telegram's 50 MB limit (see skipped.txt).`);

  await rewriteCssFiles(job);
  if (rendered) {
    const snapshot = rewriteHtml(cheerio.load(rendered.html), base, job.files, { stripScripts: true });
    await fs.writeFile(path.join(siteDir, 'index.html'), snapshot);
    const orig = rewriteHtml(cheerio.load(original), base, job.files);
    await fs.writeFile(path.join(siteDir, 'index.original.html'), orig);
  } else {
    const out = rewriteHtml(cheerio.load(html0), base, job.files);
    await fs.writeFile(path.join(siteDir, 'index.html'), out);
  }
  if (job.timedOut) warnings.push('⏱️ Time limit reached, so some files may be missing.');
  await writeInfoFiles(job, mode, first.finalUrl);
  lap('assets', t);

  t = Date.now();
  onStatus('🗜️ Creating ZIP…');
  const zipName = `${job.main.hostname.replace(/[^a-z0-9.-]/gi, '_')}.zip`;
  const zipPath = path.join(workDir, zipName);
  await zipDir(siteDir, zipPath);
  const { size } = await fs.stat(zipPath);
  lap('zip', t);
  if (size > TG_MAX_BYTES)
    throw new UserError(`📦 Even after leaving out media and images, this site's code and styles come to ${mb(size)} MB, over Telegram's 50 MB limit. I never remove CSS or JS, so I can't send this one.`, 'zip_too_big');

  const thin = mode === 'fast' && CFG.enableBrowser && !opts.forceBrowser && looksThin(html0);

  return {
    zipPath,
    zipName,
    host: job.main.host,
    title,
    fileCount: job.files.size + 1,
    zipBytes: size,
    mode,
    warnings,
    skipped: job.skipped.length,
    failed: job.failed.length,
    timings,
    thin,
  };
}

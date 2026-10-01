import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { CFG, TG_MAX_BYTES, mb } from './config.js';
import { UserError, explainNetError } from './errors.js';
import { safeFetch, readBody } from './net.js';
import { Job } from './job.js';
import { Semaphore } from './queue.js';
import { analyze, isChallengeHtml, looksLikeSpa } from './analyze.js';
import { decodeBody, rewriteHtml } from './extract.js';
import { collectAssets, rewriteCssFiles } from './assets.js';
import { renderWithBrowser } from './browser.js';
import { zipDir } from './zip.js';

const browserSem = new Semaphore(1); // Chromium is heavy: one at a time
const cfMsg = (host) => `🛡️ ${host} is behind a Cloudflare challenge that blocks automated visitors. I tried a real browser too and it didn't get through.`;

async function fetchMain(url, explicitScheme) {
  const attempt = async (u) => {
    const { res, url: finalUrl } = await safeFetch(u.href, {
      timeoutMs: 20000,
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const body = await readBody(res, CFG.maxHtmlBytes);
    if (body.tooBig) throw new UserError('📏 That page is too large to process.');
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
    lines.push('SKIPPED (too large or over limits):');
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

export async function downloadSite(parsed, workDir, onStatus = () => {}) {
  const siteDir = path.join(workDir, 'site');
  await fs.mkdir(siteDir, { recursive: true });

  await onStatus(`🌐 Fetching ${parsed.url.host}…`);
  const first = await fetchMain(parsed.url, parsed.explicitScheme);
  const isHtml = !first.contentType || /html/i.test(first.contentType);
  const html0 = isHtml ? decodeBody(first.buf, first.contentType) : '';

  if (first.status < 400 && !isHtml)
    throw new UserError(`📄 That link isn't a web page (it's ${first.contentType.split(';')[0]}). Send a page address instead.`);

  const check = analyze({
    status: first.status,
    headers: first.headers,
    html: html0,
    requestedUrl: parsed.url.href,
    finalUrl: first.finalUrl,
    isHtml,
  });
  if (check.fatal && !check.challenge) throw new UserError(check.fatal);

  const job = new Job(siteDir, first.finalUrl);
  const warnings = [...check.warnings];
  let mode = 'fast';
  let rendered = null;

  const wantBrowser = CFG.enableBrowser && (check.challenge || looksLikeSpa(html0));
  if (wantBrowser) {
    try {
      await onStatus('🧭 Loading it in a headless browser…');
      rendered = await browserSem.run(() => renderWithBrowser(job, first.finalUrl));
      if (isChallengeHtml(rendered.html)) throw new UserError(cfMsg(job.main.host));
      mode = 'browser';
    } catch (e) {
      if (e instanceof UserError) throw e;
      console.error('browser mode failed:', e?.message);
      if (check.challenge) throw new UserError(cfMsg(job.main.host));
      rendered = null;
      warnings.push('⚠️ The headless browser failed, so I saved the static HTML only.');
    }
  } else if (check.challenge) {
    throw new UserError(check.fatal);
  }

  const base = rendered ? rendered.finalUrl : first.finalUrl;
  const original = (rendered && rendered.originalHtml) || html0;
  const docs = rendered ? [rendered.html, original] : [html0];

  await onStatus('📦 Downloading assets…');
  await collectAssets(job, docs, base);
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

  await onStatus('🗜️ Creating ZIP…');
  const zipName = `${job.main.hostname.replace(/[^a-z0-9.-]/gi, '_')}.zip`;
  const zipPath = path.join(workDir, zipName);
  await zipDir(siteDir, zipPath);
  const { size } = await fs.stat(zipPath);
  if (size > TG_MAX_BYTES)
    throw new UserError(`📦 The ZIP came out at ${mb(size)} MB, over Telegram's 50 MB limit. Try a lighter page.`);

  return {
    zipPath,
    zipName,
    host: job.main.host,
    fileCount: job.files.size + 1,
    zipBytes: size,
    mode,
    warnings,
    skipped: job.skipped.length,
    failed: job.failed.length,
  };
}

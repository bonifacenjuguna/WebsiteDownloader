import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { CFG, mb } from './config.js';
import { safeFetch, readBody } from './net.js';
import { discover, cssRefs, rewriteCss } from './extract.js';
import { UserError } from './errors.js';
import { Semaphore } from './queue.js';

// big files are buffered in memory while downloading: only a couple at a time (the bot shares ~1 GB with Chromium)
const bigSem = new Semaphore(2);
const BIG = 4 * 1024 * 1024;

const isCss = (f) => f.type === 'text/css' || /\.css$/i.test(f.local);

export async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => {
    while (q.length) await fn(q.shift());
  }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT = /TimeoutError|AbortError|ECONNRESET|ETIMEDOUT|UND_ERR/;

export async function fetchAsset(job, url) {
  if (job.attempted.has(url) || job.files.has(url)) return;
  job.attempted.add(url);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (job.expired()) return;
    try {
      const { res } = await safeFetch(url, { timeoutMs: job.limits.fetchTimeoutMs, headers: { referer: job.main.href, accept: '*/*' } });
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
          const ra = Number(res.headers.get('retry-after'));
          await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 600, 2000));
          continue; // one retry for rate limits / server hiccups
        }
        job.failed.push({ url, reason: `HTTP ${res.status}` });
        return;
      }
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const declared = Number(res.headers.get('content-length') || 0);
      const body = declared > BIG
        ? await bigSem.run(() => readBody(res, job.limits.maxFileBytes))
        : await readBody(res, job.limits.maxFileBytes);
      if (body.tooBig) {
        job.skipped.push({ url, reason: `larger than ${mb(job.limits.maxFileBytes)} MB`, size: body.size });
        return;
      }
      await job.add(url, body.buf, type);
      return;
    } catch (e) {
      const tag = `${e?.name} ${e?.code} ${e?.cause?.code}`;
      if (attempt === 0 && !(e instanceof UserError) && TRANSIENT.test(tag)) { await sleep(500); continue; }
      job.failed.push({ url, reason: e?.message || String(e) });
      return;
    }
  }
}

async function runPool(job, list) {
  job.progress.total += list.length;
  await pool(list, CFG.assetConcurrency, async (u) => {
    await fetchAsset(job, u);
    job.progress.done++;
    job.onProgress?.(job.progress.done, job.progress.total);
  });
}

export async function collectAssets(job, htmlDocs, base, extraUrls = []) {
  const urls = new Set(extraUrls);
  for (const doc of htmlDocs) {
    const html = typeof doc === 'string' ? doc : doc.html;
    const docBase = typeof doc === 'string' ? base : doc.base; // multi-page: every page has its own base URL
    const $ = cheerio.load(html);
    for (const u of discover($, docBase)) urls.add(u);
  }
  await runPool(job, [...urls]);

  // follow url() / @import inside CSS (up to 3 levels)
  const done = new Set();
  for (let round = 0; round < 3; round++) {
    const css = [...job.files.values()].filter((f) => isCss(f) && !done.has(f.url));
    if (!css.length) break;
    const next = new Set();
    for (const f of css) {
      done.add(f.url);
      const text = await fs.readFile(path.join(job.dir, f.local), 'utf8');
      for (const u of cssRefs(text, f.url)) next.add(u);
    }
    await runPool(job, [...next]);
  }
}

export async function rewriteCssFiles(job) {
  for (const f of job.files.values()) {
    if (!isCss(f)) continue;
    const p = path.join(job.dir, f.local);
    const text = await fs.readFile(p, 'utf8');
    const out = rewriteCss(text, f.url, f.local, job.files);
    if (out !== text) await fs.writeFile(p, out);
  }
}

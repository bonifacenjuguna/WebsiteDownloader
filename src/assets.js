import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { CFG, mb } from './config.js';
import { safeFetch, readBody, withHost } from './net.js';
import * as shared from './sharedcache.js';
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
  // popular library / font files come from the shared cache: no network at all
  const hit = await shared.get(url);
  if (hit) { await job.add(url, hit.buf, hit.type); return; }
  let host;
  try { host = new URL(url).host; } catch { job.failed.push({ url, reason: 'bad address' }); return; }
  await withHost(host, () => download(job, url));
}

async function download(job, url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (job.expired()) return;
    try {
      const { res } = await safeFetch(url, { timeoutMs: job.limits.fetchTimeoutMs, signal: job.signal || undefined, headers: { referer: job.main.href, accept: '*/*' } });
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
      const read = () => readBody(res, job.limits.maxFileBytes, { stallMs: CFG.stallMs });
      const body = declared > BIG ? await bigSem.run(read) : await read();
      if (body.tooBig) {
        job.skipped.push({ url, reason: `larger than ${mb(job.limits.maxFileBytes)} MB`, size: body.size });
        return;
      }
      await job.add(url, body.buf, type);
      if (job.files.has(url)) shared.put(url, body.buf, type); // fire and forget
      return;
    } catch (e) {
      const tag = `${e?.name} ${e?.code} ${e?.cause?.code}`;
      if (attempt === 0 && !(e instanceof UserError) && TRANSIENT.test(tag)) { await sleep(500); continue; }
      job.failed.push({ url, reason: e?.message || String(e) });
      return;
    }
  }
}

// Downloads everything a set of pages needs as ONE pipeline: a stylesheet is read the moment it arrives and the
// files it names (fonts, images, @import) join the queue straight away, instead of waiting for a "round" to finish.
// Nested stylesheets are followed up to 3 levels deep.
export async function collectAssets(job, htmlDocs, base, extraUrls = []) {
  const urls = new Set(extraUrls);
  for (const doc of htmlDocs) {
    const html = typeof doc === 'string' ? doc : doc.html;
    const docBase = typeof doc === 'string' ? base : doc.base; // multi-page: every page has its own base URL
    const $ = cheerio.load(html);
    for (const u of discover($, docBase)) urls.add(u);
  }

  const queue = [...urls];
  const queued = new Set(urls);
  const cssDepth = new Map();
  job.progress.total += queue.length;
  let inflight = 0;
  const idle = [];
  const wake = () => { while (idle.length) idle.shift()(); };

  async function expandCss(rec) {
    const depth = cssDepth.get(rec.url) ?? 0;
    if (depth >= 3) return;
    let text;
    try { text = await fs.readFile(path.join(job.dir, rec.local), 'utf8'); } catch { return; }
    const fresh = [];
    for (const u of cssRefs(text, rec.url)) {
      if (queued.has(u) || job.attempted.has(u)) continue;
      queued.add(u);
      cssDepth.set(u, depth + 1);
      fresh.push(u);
    }
    if (fresh.length) { job.progress.total += fresh.length; queue.push(...fresh); }
  }

  async function worker() {
    for (;;) {
      const u = queue.shift();
      if (u === undefined) {
        if (inflight === 0) { wake(); return; }
        await new Promise((r) => idle.push(r));
        continue;
      }
      inflight++;
      try {
        await fetchAsset(job, u);
        const rec = job.files.get(u);
        if (rec && isCss(rec)) await expandCss(rec);
        job.progress.done++;
        job.onProgress?.(job.progress.done, job.progress.total);
      } finally { inflight--; wake(); }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, CFG.assetConcurrency) }, worker));
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

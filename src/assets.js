import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { CFG, mb } from './config.js';
import { safeFetch, readBody } from './net.js';
import { discover, cssRefs, rewriteCss } from './extract.js';

const isCss = (f) => f.type === 'text/css' || /\.css$/i.test(f.local);

async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => {
    while (q.length) await fn(q.shift());
  }));
}

export async function fetchAsset(job, url) {
  if (job.attempted.has(url) || job.files.has(url)) return;
  job.attempted.add(url);
  if (job.expired()) return;
  try {
    const { res } = await safeFetch(url, { headers: { referer: job.main.href, accept: '*/*' } });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      job.failed.push({ url, reason: `HTTP ${res.status}` });
      return;
    }
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const body = await readBody(res, CFG.maxFileBytes);
    if (body.tooBig) {
      job.skipped.push({ url, reason: `larger than ${mb(CFG.maxFileBytes)} MB`, size: body.size });
      return;
    }
    await job.add(url, body.buf, type);
  } catch (e) {
    job.failed.push({ url, reason: e?.message || String(e) });
  }
}

export async function collectAssets(job, htmlDocs, base) {
  const urls = new Set();
  for (const html of htmlDocs) {
    const $ = cheerio.load(html);
    for (const u of discover($, base)) urls.add(u);
  }
  await pool([...urls], CFG.assetConcurrency, (u) => fetchAsset(job, u));

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
    await pool([...next], CFG.assetConcurrency, (u) => fetchAsset(job, u));
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

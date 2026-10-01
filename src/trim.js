import fs from 'node:fs/promises';
import path from 'node:path';
import { TG_TARGET_BYTES } from './config.js';

// Lower rank = dropped first. Media and big images go before fonts, and code/styles are kept to the end.
const rank = (f) => {
  if (/\.(mp4|webm|mov|mp3|ogg|wav|m4a)$/i.test(f.local) || /^(video|audio)\//.test(f.type)) return 0;
  if (/\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(f.local) || /^image\/(?!svg)/.test(f.type)) return 1;
  if (/\.(woff2?|ttf|otf|eot)$/i.test(f.local) || /^font\//.test(f.type)) return 2;
  return 3;
};
// already-compressed formats stay at full size in the ZIP; text compresses roughly 3x
const estimate = (f) => (rank(f) <= 2 ? f.size : Math.round(f.size * 0.35));

export async function trimToBudget(job, target = TG_TARGET_BYTES) {
  const files = [...job.files.values()];
  let total = files.reduce((n, f) => n + estimate(f), 0);
  if (total <= target) return 0;
  files.sort((a, b) => rank(a) - rank(b) || b.size - a.size);
  let removed = 0;
  for (const f of files) {
    if (total <= target) break;
    await fs.rm(path.join(job.dir, f.local), { force: true });
    job.files.delete(f.url);
    job.totalBytes -= f.size;
    job.skipped.push({ url: f.url, reason: "trimmed to fit Telegram's 50 MB limit", size: f.size });
    total -= estimate(f);
    removed++;
  }
  return removed;
}

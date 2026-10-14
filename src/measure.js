import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { rank } from './trim.js';

// Real sizes inside the ZIP, so parts can be filled right up to the limit without overshooting.
// Text is measured by actually deflating it (level 3, the same as the archiver); everything else is stored as it is.
// Each ZIP entry also costs a header (local + central directory) that grows with the file name.
export const entryOverhead = (name) => 110 + 2 * Buffer.byteLength(name);
const MAX_MEASURE = 24 * 1024 * 1024; // beyond this the estimate is fine and the CPU is better spent elsewhere

export async function measureZipSizes(job, pageRecs) {
  let measured = 0;
  for (const p of pageRecs) {
    const html = p.html ?? p.page?.html; // a page record from the crawler carries its page
    if (html == null) continue;
    p.zsize = zlib.deflateRawSync(Buffer.from(html), { level: 3 }).length + entryOverhead(p.local);
    measured++;
  }
  for (const f of job.files.values()) {
    if (f.alias) continue;
    if (rank(f) <= 2) { f.zsize = f.size + entryOverhead(f.local); continue; }       // images, video, fonts, documents: stored as they are
    if (f.size > MAX_MEASURE) continue;
    try {
      f.zsize = zlib.deflateRawSync(await fs.readFile(path.join(job.dir, f.local)), { level: 3 }).length + entryOverhead(f.local);
      measured++;
    } catch { /* keep the estimate */ }
  }
  return measured;
}

import fs from 'node:fs/promises';
import path from 'node:path';

// Smart size budgeting: when a site would not fit in the ZIP parts, shrink its images FIRST and only then leave
// things out. Same file name and format, so no link has to change. Uses `sharp` when it is installed
// (optional dependency); without it the bot simply skips this step.
let sharp;
async function getSharp() {
  if (sharp !== undefined) return sharp;
  try { sharp = (await import('sharp')).default; } catch { sharp = null; console.log('Image compression: sharp not installed (skipping)'); }
  return sharp;
}

const KIND = (f) => {
  if (/\.(jpe?g)$/i.test(f.local) || f.type === 'image/jpeg') return 'jpeg';
  if (/\.png$/i.test(f.local) || f.type === 'image/png') return 'png';
  if (/\.webp$/i.test(f.local) || f.type === 'image/webp') return 'webp';
  return null;
};

export async function compressImages(job, { needBytes, minBytes = 120 * 1024, maxWidth = 2000 } = {}) {
  const sh = await getSharp();
  if (!sh) return { count: 0, saved: 0 };
  const list = [...job.files.values()].filter((f) => KIND(f) && f.size >= minBytes).sort((a, b) => b.size - a.size);
  let saved = 0;
  let count = 0;
  for (const f of list) {
    if (saved >= needBytes || job.expired()) break;
    const file = path.join(job.dir, f.local);
    try {
      const input = await fs.readFile(file);
      const meta = await sh(input, { failOn: 'none' }).metadata();
      if ((meta.pages || 1) > 1) continue; // animated
      let pipe = sh(input, { failOn: 'none' }).resize({ width: maxWidth, withoutEnlargement: true });
      const kind = KIND(f);
      if (kind === 'jpeg') pipe = pipe.jpeg({ quality: 72, mozjpeg: true });
      else if (kind === 'png') pipe = pipe.png({ palette: true, quality: 70, compressionLevel: 9 });
      else pipe = pipe.webp({ quality: 70 });
      const out = await pipe.toBuffer();
      if (out.length > input.length * 0.9) continue; // not worth the quality loss
      await fs.writeFile(file, out);
      saved += input.length - out.length;
      job.totalBytes -= input.length - out.length;
      f.size = out.length;
      count++;
    } catch { /* unreadable image: leave it alone */ }
  }
  return { count, saved };
}

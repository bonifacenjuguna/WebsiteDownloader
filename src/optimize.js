import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CFG } from './config.js';

// Lossless image optimizing: the same pixels in fewer bytes. The copy stays an exact mirror.
//   PNG   re-packed with maximum compression (sharp)
//   JPEG  Huffman tables optimized and made progressive, metadata kept (jpegtran, a lossless transform)
// Nothing is trusted: every result is DECODED and compared with the original pixel by pixel, and anything that differs,
// or saves less than 3%, is thrown away and the original is kept. Animated PNGs, 16-bit PNGs and anything unreadable are
// left alone. With no way to verify (sharp missing) nothing is touched at all.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function kindOf(file, buf) {
  if (buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  return null;
}

// can this PNG be re-packed without changing what it shows? (8-bit, not animated)
export function pngIsSafe(buf) {
  if (buf.length < 33 || buf.toString('latin1', 12, 16) !== 'IHDR') return false;
  if (buf[24] !== 8) return false;                                   // bit depth: 16-bit images are left alone
  const head = buf.toString('latin1', 0, Math.min(buf.length, 4096));
  return !head.includes('acTL');                                     // APNG: re-encoding would drop the animation
}

// ---------------------------------------------------------------- the real engine (sharp + jpegtran), loaded on demand
export async function realEngine() {
  let sharp = null;
  try { sharp = (await import('sharp')).default; } catch { /* optional */ }
  if (!sharp) return { available: false };
  const open = (b) => sharp(b, { failOn: 'none', limitInputPixels: 80_000_000 });
  const decode = async (b) => { const { data, info } = await open(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, w: info.width, h: info.height, c: info.channels }; };
  let jpegtran; // undefined = not asked yet
  const runJpegtran = (buf) => new Promise((resolve) => {
    const p = spawn('jpegtran', ['-copy', 'all', '-optimize', '-progressive'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const out = [];
    const timer = setTimeout(() => p.kill('SIGKILL'), 20_000);
    p.stdout.on('data', (c) => out.push(c));
    p.on('error', () => { clearTimeout(timer); jpegtran = false; resolve(null); }); // not installed
    p.on('close', (code) => { clearTimeout(timer); if (jpegtran === undefined) jpegtran = true; resolve(code === 0 ? Buffer.concat(out) : null); });
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  });
  return {
    available: true,
    png: (b) => open(b).png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10, palette: false }).withMetadata().toBuffer(),
    jpeg: async (b) => (jpegtran === false ? null : runJpegtran(b)),
    async samePixels(a, b) {
      const [x, y] = await Promise.all([decode(a), decode(b)]);
      return x.w === y.w && x.h === y.h && x.c === y.c && x.data.equals(y.data);
    },
  };
}

// ---------------------------------------------------------------- the pass over a job's files
export async function optimizeLossless(job, { engine, maxMs = CFG.losslessMaxMs, minGain = 0.03, minBytes = 20 * 1024, maxFiles = 400, now = () => Date.now() } = {}) {
  const t0 = now();
  const res = { count: 0, saved: 0, tried: 0, rejected: { pixels: 0, gain: 0, unsafe: 0, error: 0 }, ms: 0, engine: false };
  const eng = engine ?? (await realEngine());
  if (!eng.available) return res;
  res.engine = true;
  const list = [...job.files.values()]
    .filter((f) => !f.alias && f.size >= minBytes && /\.(png|jpe?g)$/i.test(f.local))
    .sort((a, b) => b.size - a.size)
    .slice(0, maxFiles);
  for (const f of list) {
    if (now() - t0 > maxMs || job.expired()) break;
    const file = path.join(job.dir, f.local);
    try {
      const input = await fs.readFile(file);
      const kind = kindOf(f, input);
      if (!kind || (kind === 'png' && !pngIsSafe(input))) { res.rejected.unsafe++; continue; }
      res.tried++;
      const out = await (kind === 'png' ? eng.png(input) : eng.jpeg(input));
      if (!out?.length || out.length > input.length * (1 - minGain)) { res.rejected.gain++; continue; }
      if (!(await eng.samePixels(input, out))) { res.rejected.pixels++; continue; } // never keep a result that is not identical
      const tmp = `${file}.opt`;
      await fs.writeFile(tmp, out);
      await fs.rename(tmp, file);
      res.saved += input.length - out.length;
      job.totalBytes -= input.length - out.length;
      f.size = out.length;
      res.count++;
    } catch { res.rejected.error++; }
    await new Promise((r) => setImmediate(r)); // let the rest of the bot breathe
  }
  res.ms = now() - t0;
  return res;
}

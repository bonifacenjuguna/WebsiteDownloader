import { createWriteStream } from 'node:fs';
import archiver from 'archiver';

// already-compressed formats are stored as they are: compressing them again burns CPU for no size gain
const STORED = /\.(png|jpe?g|gif|webp|avif|mp4|webm|mov|mp3|ogg|m4a|woff2?|zip|gz|tgz|7z|rar|pdf|docx|xlsx|pptx|epub|apk)$/i;

export function zipDir(srcDir, zipPath) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 3 } });
    out.on('close', resolve);
    out.on('error', reject);
    archive.on('error', reject);
    archive.pipe(out);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}

// Zip an explicit list: { name, file } from disk, or { name, text } generated on the fly.
export function zipEntries(zipPath, entries) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 3 } });
    out.on('close', resolve);
    out.on('error', reject);
    archive.on('error', reject);
    archive.pipe(out);
    for (const e of entries) {
      if (e.text !== undefined) archive.append(e.text, { name: e.name });
      else archive.file(e.file, { name: e.name, store: STORED.test(e.name) });
    }
    archive.finalize();
  });
}

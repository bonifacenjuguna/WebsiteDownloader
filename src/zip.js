import { createWriteStream } from 'node:fs';
import archiver from 'archiver';

export function zipDir(srcDir, zipPath) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolve);
    out.on('error', reject);
    archive.on('error', reject);
    archive.pipe(out);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { CFG } from './config.js';
import { localPathFor, sha1 } from './paths.js';

export class Job {
  constructor(dir, mainUrl) {
    this.dir = dir;
    this.main = new URL(mainUrl);
    this.files = new Map();      // absolute url -> { url, local, type, size }
    this.used = new Set(['index.html', 'index.original.html', 'skipped.txt', 'readme.txt']);
    this.attempted = new Set();
    this.skipped = [];
    this.failed = [];
    this.totalBytes = 0;
    this.timedOut = false;
    this.deadline = Date.now() + CFG.jobTimeoutMs;
    this.progress = { done: 0, total: 0 };
    this.onProgress = null;
  }

  expired() {
    if (Date.now() > this.deadline) { this.timedOut = true; return true; }
    return false;
  }

  async add(url, buf, type = '') {
    this.attempted.add(url);
    const existing = this.files.get(url);
    if (existing) return existing;
    if (this.files.size >= CFG.maxFiles) {
      this.skipped.push({ url, reason: 'file-count limit reached', size: buf.length });
      return null;
    }
    if (this.totalBytes + buf.length > CFG.maxTotalBytes) {
      this.skipped.push({ url, reason: 'total size cap reached', size: buf.length });
      return null;
    }
    let local = localPathFor(url, this.main.host, type);
    if (this.used.has(local.toLowerCase())) {
      const ext = path.posix.extname(local);
      local = `${local.slice(0, local.length - ext.length)}_${sha1(url).slice(0, 6)}${ext}`;
    }
    this.used.add(local.toLowerCase());
    const rec = { url, local, type, size: buf.length };
    this.files.set(url, rec);
    this.totalBytes += buf.length;
    try {
      const full = path.join(this.dir, local);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, buf);
    } catch {
      // file/dir name clash (e.g. /fonts and /fonts/a.woff) -> fall back to a flat name
      rec.local = `_misc/${sha1(url).slice(0, 8)}_${path.posix.basename(local)}`;
      const full = path.join(this.dir, rec.local);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, buf);
    }
    return rec;
  }
}

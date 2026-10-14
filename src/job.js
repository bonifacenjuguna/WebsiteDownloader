import fs from 'node:fs/promises';
import path from 'node:path';
import { CFG } from './config.js';
import { UserError } from './errors.js';
import { localPathFor, sha1 } from './paths.js';

// binary assets whose identical copies are safe to share (never HTML, CSS, JS, SVG or JSON: those are rewritten per address)
const DEDUPE_TYPE = /^(image\/(?!svg)|font\/|video\/|audio\/|application\/(font|x-font|pdf|zip|octet-stream))/i;
const DEDUPE_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|ogg|m4a|wav|pdf|zip)$/i;

export class Job {
  constructor(dir, mainUrl, limits = {}) {
    this.dir = dir;
    this.main = new URL(mainUrl);
    this.files = new Map();      // absolute url -> { url, local, type, size, alias? }  (alias: same bytes as another file, stored once)
    this.byHash = new Map();     // content hash -> the record that holds those bytes
    this.dedupedBytes = 0;
    this.used = new Set(['index.html', 'index.original.html', 'skipped.txt', 'readme.txt']);
    this.attempted = new Set();
    this.skipped = [];
    this.failed = [];
    this.totalBytes = 0;
    this.timedOut = false;
    this.cancelled = false;
    this.signal = limits.signal || null; // user pressed Cancel
    this.limits = {
      maxFiles: CFG.maxFiles, maxTotalBytes: CFG.maxTotalBytes, maxFileBytes: CFG.maxFileBytes,
      timeoutMs: CFG.jobTimeoutMs, fetchTimeoutMs: CFG.fetchTimeoutMs, ...limits,
    };
    this.localOverrides = new Map(); // url -> chosen path inside the ZIP
    this.deadline = Date.now() + this.limits.timeoutMs;
    this.progress = { done: 0, total: 0 };
    this.onProgress = null;
  }

  expired() {
    if (this.signal?.aborted) { this.cancelled = true; return true; }
    if (Date.now() > this.deadline) { this.timedOut = true; return true; }
    return false;
  }

  // called between phases: stops the job quickly when the user cancelled
  throwIfCancelled() {
    if (this.signal?.aborted || this.cancelled) throw new UserError('cancelled', 'cancelled');
  }

  async add(url, buf, type = '') {
    this.attempted.add(url);
    const existing = this.files.get(url);
    if (existing) return existing;
    if (this.files.size >= this.limits.maxFiles) {
      this.skipped.push({ url, reason: 'file-count limit reached', size: buf.length });
      return null;
    }
    if (this.totalBytes + buf.length > this.limits.maxTotalBytes) {
      this.skipped.push({ url, reason: 'total size cap reached', size: buf.length });
      return null;
    }
    // The same bytes under another address (a logo linked from ten pages with ten URLs, a font served from two CDNs) is stored
    // ONCE; every address points at the one file. Only for binary assets: text is rewritten per address, so it stays separate.
    const dedupe = DEDUPE_TYPE.test(type) || DEDUPE_EXT.test(url.split(/[?#]/)[0]);
    const hash = dedupe ? sha1(buf) : null;
    const twin = hash && this.byHash.get(hash);
    if (twin) {
      const alias = { url, local: twin.local, type: type || twin.type, size: buf.length, alias: true };
      this.files.set(url, alias);
      this.dedupedBytes += buf.length;
      return alias;
    }
    let local = this.localOverrides.get(url) || localPathFor(url, this.main.host, type);
    if (this.used.has(local.toLowerCase())) {
      const ext = path.posix.extname(local);
      local = `${local.slice(0, local.length - ext.length)}_${sha1(url).slice(0, 6)}${ext}`;
    }
    this.used.add(local.toLowerCase());
    const rec = { url, local, type, size: buf.length };
    this.files.set(url, rec);
    if (hash) this.byHash.set(hash, rec);
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

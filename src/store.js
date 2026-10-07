import Redis from 'ioredis';
import { CFG } from './config.js';
import * as db from './db.js';
import { THIN_MARK } from './copy.js';

let lastWarn = 0;
const warn = (e) => {
  if (Date.now() - lastWarn > 10000) { lastWarn = Date.now(); console.warn('[redis]', e?.message || e); }
};

class MemoryKV {
  constructor() {
    this.m = new Map();
    setInterval(() => {
      const n = Date.now();
      for (const [k, v] of this.m) if (v.exp <= n) this.m.delete(k);
    }, 60_000).unref();
  }
  async get(k) {
    const v = this.m.get(k);
    if (!v) return null;
    if (v.exp <= Date.now()) { this.m.delete(k); return null; }
    return v.val;
  }
  async set(k, val, ttlMs) { this.m.set(k, { val, exp: Date.now() + ttlMs }); }
  async setNx(k, val, ttlMs) {
    if ((await this.get(k)) !== null) return false;
    await this.set(k, val, ttlMs);
    return true;
  }
  async del(k) { this.m.delete(k); }
  async pttl(k) { const v = this.m.get(k); return v ? Math.max(0, v.exp - Date.now()) : -2; }
  async incr(k, ttlMs) {
    const cur = Number(await this.get(k)) || 0;
    const exp = this.m.get(k)?.exp ?? Date.now() + ttlMs;
    this.m.set(k, { val: String(cur + 1), exp });
    return cur + 1;
  }
  async close() {}
}

// Every Redis call fails OPEN: if Redis hiccups the bot keeps working, just without caching/limits.
class RedisKV {
  constructor(url) {
    this.r = new Redis(url, {
      family: 0, // Railway private network is dual-stack/IPv6
      keyPrefix: 'wd:',
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 2000,
      connectTimeout: 5000,
    });
    this.r.on('error', warn);
  }
  ready() {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connect timeout')), 6000);
      this.r.once('ready', () => { clearTimeout(t); resolve(); });
    });
  }
  async #s(fn, fallback) { try { return await fn(); } catch (e) { warn(e); return fallback; } }
  get(k) { return this.#s(() => this.r.get(k), null); }
  async set(k, v, ttlMs) { await this.#s(() => this.r.set(k, v, 'PX', ttlMs)); }
  setNx(k, v, ttlMs) { return this.#s(async () => (await this.r.set(k, v, 'PX', ttlMs, 'NX')) === 'OK', true); }
  async del(k) { await this.#s(() => this.r.del(k)); }
  pttl(k) { return this.#s(() => this.r.pttl(k), -2); }
  incr(k, ttlMs) {
    return this.#s(async () => {
      const n = await this.r.incr(k);
      if (n === 1) await this.r.pexpire(k, ttlMs);
      return n;
    }, 0); // fail open: Redis down = not counted
  }
  async close() { await this.r.quit().catch(() => {}); }
}

export let kv = new MemoryKV();
export let kvMode = 'memory';

export async function initStore() {
  if (!CFG.redisUrl) { console.log('Redis: not configured (using in-memory cache and limits)'); return; }
  const r = new RedisKV(CFG.redisUrl);
  try {
    await r.ready();
    kv = r;
    kvMode = 'redis';
    console.log('Redis: connected');
  } catch (e) {
    console.error('Redis unavailable, using in-memory fallback:', e.message);
    r.r.disconnect();
  }
}
export const closeStore = () => kv.close();

const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export const cache = {
  // hot layer: Redis. durable layer: Postgres (survives a Redis flush)
  async getResult(key) {
    const hot = parse(await kv.get(`res:${key}`));
    if (hot) return hot;
    const row = await db.findFresh(key, CFG.cacheTtlMs / 1000);
    if (!row) return null;
    const data = {
      urlKey: row.url_key, fileId: row.tg_file_id, fileName: row.file_name, caption: row.caption || `✅ ${row.host}`,
      host: row.host, title: row.title, thin: (row.caption || '').includes(THIN_MARK), section: (row.mode || '').startsWith('site-'), mode: row.mode, files: row.files, zipBytes: Number(row.zip_bytes || 0),
      at: new Date(row.created_at).getTime(),
    };
    const left = data.at + CFG.cacheTtlMs - Date.now();
    if (left > 0) await kv.set(`res:${key}`, JSON.stringify(data), left);
    return data;
  },
  setResult: (key, data) => kv.set(`res:${key}`, JSON.stringify(data), CFG.cacheTtlMs),
  dropResult: (key) => kv.del(`res:${key}`),
  async getNegative(key) { return parse(await kv.get(`neg:${key}`)); },
  setNegative: (key, err) => kv.set(`neg:${key}`, JSON.stringify(err), CFG.negTtlMs),
  // buttons carry only the 40-char key; this maps it back to the URL
  rememberUrl: (key, url) => kv.set(`url:${key}`, url, 24 * 60 * 60 * 1000),
  async urlFor(key) { return (await kv.get(`url:${key}`)) || (await db.urlForKey(key)); },
};

export const limits = {
  tryAcquire: (uid) => kv.setNx(`busy:${uid}`, '1', 30 * 60 * 1000), // long crawls + several uploads
  async cooldownLeft(uid) { const t = await kv.pttl(`cd:${uid}`); return t > 0 ? t : 0; },
  async release(uid, ran) {
    await kv.del(`busy:${uid}`);
    if (ran) await kv.set(`cd:${uid}`, '1', CFG.cooldownMs);
  },
};

export const previews = {
  get: (key) => kv.get(`prev:${key}`),
  set: (key, fileId) => kv.set(`prev:${key}`, fileId, CFG.cacheTtlMs),
  cooldownOk: (uid) => kv.setNx(`pcd:${uid}`, '1', 10_000),
};

const dayStamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
export const quota = {
  // returns how many new downloads this user has started today (UTC), including this one
  consume: (uid) => kv.incr(`quota:${uid}:${dayStamp()}`, 26 * 60 * 60 * 1000),
};

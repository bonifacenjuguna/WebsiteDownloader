import dns from 'node:dns/promises';
import net from 'node:net';
import { CFG } from './config.js';
import { UserError } from './errors.js';

const blocked = () => new UserError("🛑 That address is private or internal, so I can't download it.", 'blocked_address');
const BLOCKED_NAME = /(^|\.)(localhost|local|internal|localdomain|lan|home|corp)$/i;

function privV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
function privV6(ip) {
  const l = ip.toLowerCase();
  if (l === '::' || l === '::1') return true;
  if (l.startsWith('::ffff:')) {
    const v4 = l.slice(7);
    return net.isIPv4(v4) ? privV4(v4) : true;
  }
  return /^(fc|fd|fe[89ab])/.test(l);
}
export const isPrivateIp = (ip) => (net.isIPv4(ip) ? privV4(ip) : privV6(ip));

const cache = new Map();
export async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const hit = cache.get(host);
  if (hit && hit > Date.now()) return;
  if (BLOCKED_NAME.test(host)) throw blocked();
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw blocked();
  } else {
    if (!host.includes('.')) throw blocked();
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw blocked();
  }
  cache.set(host, Date.now() + 60_000);
}

// ---------- per-host politeness ----------
// Requests to one host are spaced out. The gap doubles when the host answers 429/503 (and honours Retry-After),
// then relaxes again while things go well, so the bot never hammers a small site and rarely gets blocked.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gates = new Map(); // host -> { next, gap, seen }
setInterval(() => {
  const old = Date.now() - 10 * 60 * 1000;
  for (const [h, g] of gates) if (g.seen < old) gates.delete(h);
}, 5 * 60 * 1000).unref();

async function gate(host) {
  let g = gates.get(host);
  if (!g) { g = { next: 0, gap: CFG.hostGapMs, seen: 0 }; gates.set(host, g); }
  const now = Date.now();
  g.seen = now;
  const at = Math.max(now, g.next);
  g.next = at + g.gap;
  if (at > now) await sleep(at - now);
}
function penalize(host, res) {
  const g = gates.get(host);
  if (!g) return;
  const ra = res.headers.get('retry-after');
  let ms = Number(ra) * 1000;
  if (!Number.isFinite(ms) && ra) ms = new Date(ra).getTime() - Date.now();
  g.gap = Math.min(2000, Math.max(100, g.gap * 2));
  g.next = Math.max(g.next, Date.now() + Math.min(Number.isFinite(ms) && ms > 0 ? ms : g.gap * 4, 10_000));
}
function relax(host) {
  const g = gates.get(host);
  if (g && g.gap > CFG.hostGapMs) g.gap = Math.max(CFG.hostGapMs, Math.floor(g.gap * 0.9));
}
export const hostGapNow = (host) => gates.get(host)?.gap ?? CFG.hostGapMs;

// fetch with manual redirects so every hop is SSRF-checked (and spaced out per host)
export async function safeFetch(urlStr, { timeoutMs = CFG.fetchTimeoutMs, headers = {}, maxRedirects = 5, signal } = {}) {
  let current = new URL(urlStr);
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicHost(current.hostname);
    await gate(current.host);
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(current, {
      redirect: 'manual',
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      headers: { 'user-agent': CFG.ua, 'accept-language': 'en-US,en;q=0.9', ...headers },
    });
    if (res.status === 429 || res.status === 503) penalize(current.host, res); else if (res.ok) relax(current.host);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return { res, url: current };
      const next = new URL(loc, current);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new UserError('Blocked redirect to an unsupported address.', 'blocked_address');
      res.body?.cancel().catch(() => {});
      current = next;
      continue;
    }
    return { res, url: current };
  }
  throw new Error('Too many redirects');
}

export async function readBody(res, maxBytes) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) {
    res.body?.cancel().catch(() => {});
    return { tooBig: true, size: len };
  }
  if (!res.body) return { buf: Buffer.alloc(0), size: 0 };
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) return { tooBig: true, size };
    chunks.push(chunk);
  }
  return { buf: Buffer.concat(chunks), size };
}

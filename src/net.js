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

// fetch with manual redirects so every hop is SSRF-checked
export async function safeFetch(urlStr, { timeoutMs = CFG.fetchTimeoutMs, headers = {}, maxRedirects = 5 } = {}) {
  let current = new URL(urlStr);
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicHost(current.hostname);
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': CFG.ua, 'accept-language': 'en-US,en;q=0.9', ...headers },
    });
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

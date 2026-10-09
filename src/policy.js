// Rules about WHO may fetch WHAT: the admin block list, and protection against abuse.
import { CFG } from './config.js';
import { kv } from './store.js';
import * as db from './db.js';
import { bareHost } from './url.js';

// ---------- blocked domains: BLOCKED_DOMAINS plus the list admins manage with /block and /unblock ----------
const blocked = new Set(CFG.blockedDomains.map(bareHost));

export async function loadBlocked() {
  for (const d of await db.blockedDomains()) blocked.add(d);
  return blocked.size;
}
export const blockedList = () => [...blocked].sort();

const clean = (d) => bareHost(String(d || '').trim().replace(/^https?:\/\//i, '').split('/')[0]);
export const validDomain = (d) => /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(clean(d));

export async function addBlocked(domain, by) { const d = clean(domain); blocked.add(d); await db.blockDomain(d, by); return d; }
export async function removeBlocked(domain) {
  const d = clean(domain);
  const had = blocked.delete(d);
  await db.unblockDomain(d);
  return had;
}
// matches the domain itself and every subdomain
export function isBlocked(host) {
  const h = bareHost(host);
  for (const d of blocked) if (h === d || h.endsWith(`.${d}`)) return true;
  return false;
}

// ---------- abuse: too many failed attempts in a row -> a short pause ----------
// Only failures that are the sender's doing count (typos, dead sites, files instead of pages), not our own errors.
const STRIKE_CODES = new Set(['dns', 'not_found', 'timeout', 'refused', 'reset', 'network', 'ssl', 'server_error', 'forbidden', 'not_html', 'empty_listing', 'zip_too_big', 'invalid_url']);
export const strikes = {
  async pausedMs(uid) { const t = await kv.pttl(`pause:${uid}`); return t > 0 ? t : 0; },
  async fail(uid, code) {
    if (!STRIKE_CODES.has(code)) return;
    const n = await kv.incr(`strike:${uid}`, 60 * 60 * 1000);
    if (n >= CFG.failStrikes) { await kv.set(`pause:${uid}`, '1', CFG.failPauseMs); await kv.del(`strike:${uid}`); }
  },
  async clear(uid) { await kv.del(`strike:${uid}`); },
};

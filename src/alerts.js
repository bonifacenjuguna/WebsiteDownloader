// Tells admins when something is wrong, so problems are noticed before users complain.
// Alerts are rate-limited: one per topic per hour, and the error-rate alert at most every 30 minutes.
import { CFG } from './config.js';

let send = async () => {};
export const setNotifier = (fn) => { send = fn; };

const sent = new Map();
export async function notifyOnce(topic, text, everyMs = 60 * 60 * 1000) {
  if (!CFG.adminIds.length) return;
  const last = sent.get(topic) || 0;
  if (Date.now() - last < everyMs) return;
  sent.set(topic, Date.now());
  try { await send(text); } catch (e) { console.warn('[alerts] could not notify admins:', e?.message); }
}

// failures that are about the visitor's input or the target site, not about this bot
const NOT_OUR_PROBLEM = new Set([
  'invalid_url', 'blocked_address', 'blocked_domain', 'dns', 'not_found', 'not_html', 'cancelled', 'forbidden', 'auth',
  'cloudflare', 'bot_blocked', 'geo_blocked', 'ssl', 'refused', 'reset', 'redirects', 'empty_listing', 'listing_unsavable',
  'queue_full', 'too_many_failures', 'zip_too_big', 'too_large', 'rate_limited',
]);

const recent = []; // last jobs: { ok, code }
export function recordJob(ok, code = '') {
  if (code === 'cancelled') return;
  recent.push({ ok, code });
  if (recent.length > 20) recent.shift();
  const counted = recent.filter((r) => r.ok || !NOT_OUR_PROBLEM.has(r.code));
  if (counted.length < 10) return;
  const bad = counted.filter((r) => !r.ok);
  if (bad.length / counted.length < 0.5) return;
  const tally = {};
  for (const b of bad) tally[b.code || 'unknown'] = (tally[b.code || 'unknown'] || 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  notifyOnce('error-rate', `⚠️ <b>${bad.length} of the last ${counted.length} jobs failed</b>\nMost common: <code>${top[0]}</code> (${top[1]})\n<i>Check /stats and the logs.</i>`, 30 * 60 * 1000);
}

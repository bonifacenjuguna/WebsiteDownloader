// Tells admins when something is wrong, so problems are noticed before users complain.
// Alerts are rate-limited: one per topic per hour, and the error-rate alert at most every 30 minutes.
import { CFG } from './config.js';
import { VISITOR_CODES } from './codes.js';

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

const recent = []; // last jobs: { ok, code }
export function recordJob(ok, code = '') {
  if (code === 'cancelled') return;
  recent.push({ ok, code });
  if (recent.length > 20) recent.shift();
  const counted = recent.filter((r) => r.ok || !VISITOR_CODES.has(r.code));
  if (counted.length < 10) return;
  const bad = counted.filter((r) => !r.ok);
  if (bad.length / counted.length < 0.5) return;
  const tally = {};
  for (const b of bad) tally[b.code || 'unknown'] = (tally[b.code || 'unknown'] || 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  notifyOnce('error-rate', `⚠️ <b>${bad.length} of the last ${counted.length} jobs failed</b>\nMost common: <code>${top[0]}</code> (${top[1]})\n<i>Check /stats and the logs.</i>`, 30 * 60 * 1000);
}

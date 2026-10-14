// "10m", "30m", "2h", "1d", "7d", "1.5h", "90s", "0" -> milliseconds. A bare number means minutes.
// Anything else (including negatives and nonsense) gives the fallback, so a typo in a variable can never break the bot.
const UNIT = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export function parseDuration(text, fallbackMs) {
  if (text === undefined || text === null) return fallbackMs;
  const t = String(text).trim().toLowerCase();
  if (!t) return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?$/.exec(t);
  if (!m) return fallbackMs;
  const ms = Math.round(Number(m[1]) * (UNIT[m[2] || 'm']));
  return Number.isFinite(ms) ? ms : fallbackMs;
}

// 600000 -> "10 minutes", 0 -> "every time"
export function describeDuration(ms) {
  if (ms === 0) return 'every time';
  const parts = [[604_800_000, 'week'], [86_400_000, 'day'], [3_600_000, 'hour'], [60_000, 'minute'], [1000, 'second']];
  for (const [size, name] of parts) if (ms >= size && ms % size === 0) { const n = ms / size; return `${n} ${name}${n === 1 ? '' : 's'}`; }
  return `${Math.round(ms / 1000)} seconds`;
}

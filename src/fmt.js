// One small formatting vocabulary for every message the bot sends (Telegram HTML):
//   bold   = titles and the one thing to look at          <code> = values you might copy (ids, hosts, numbers)
//   italic = hints, notes and footers                     🟢🟡🔴 = health at a glance
// Anything that came from outside (page titles, paths, user text) goes through esc() first.
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const b = (s) => `<b>${s}</b>`;
export const i = (s) => `<i>${s}</i>`;
export const code = (s) => `<code>${esc(s)}</code>`;

// health dots: lower is better unless `higherIsBetter`
export const dot = (value, warn, bad, higherIsBetter = false) => {
  if (value == null || Number.isNaN(value)) return '⚪';
  const v = higherIsBetter ? -value : value;
  const w = higherIsBetter ? -warn : warn;
  const d = higherIsBetter ? -bad : bad;
  return v >= d ? '🔴' : v >= w ? '🟡' : '🟢';
};

export const ms = (n) => (n == null ? '–' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);

export function uptime(msTotal) {
  const s = Math.floor(msTotal / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function utc(msStamp) {
  const d = new Date(msStamp);
  const p = (n) => String(n).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

// a monospace block with aligned columns: rows = [[label, value], ...]
export function table(rows) {
  const w = Math.max(...rows.map(([l]) => String(l).length));
  return `<pre>${rows.map(([l, v]) => `${esc(String(l).padEnd(w))}  ${esc(v)}`).join('\n')}</pre>`;
}

// "Title\nbody" -> bold title, italic body (works on translated text too)
export function titled(text) {
  const [head, ...rest] = String(text).split('\n');
  return rest.length ? `${b(head)}\n${i(rest.join('\n'))}` : b(head);
}

// "❓ First sentence. More detail." -> bold first sentence (with its emoji), detail below it
export function styleError(text) {
  const m = /^(.+?[.!?…。])(?:\s+([\s\S]+))?$/.exec(String(text));
  if (!m) return b(text);
  return m[2] ? `${b(m[1])}\n${m[2]}` : b(m[1]);
}

// Telegram refuses a whole message when one tag is malformed. This is the last-resort plain-text version.
export const stripTags = (html) => String(html)
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

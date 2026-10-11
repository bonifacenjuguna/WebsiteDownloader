// How archive posts look. One layout, everywhere:
//
//   📦 example.com                      <- bold site
//   Page title                          <- escaped, trimmed
//   🗓 Oct 10, 2026 · 21:03 UTC
//   📄 12 pages · 🗂 80 files · 💾 5.0 MB
//   ⏳ Live until Oct 17                <- Live only (Vault says where it came from)
//
//   #example_com #2026_10 #id_a3f9c2    <- searchable inside Telegram
//
// Posts never contain anything about the person who asked: no id, no name, no username.
import { esc, b, i, code } from '../fmt.js';
import { size } from '../copy.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');
export const shortDate = (ts) => { const d = new Date(ts); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
export const fullDate = (ts) => { const d = new Date(ts); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} · ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`; };

// "Example-Site.co.ke" -> "#example_site_co_ke" (Telegram hashtags: letters, digits, underscores)
export function hashtag(text, max = 40) {
  const t = String(text).toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max).replace(/_+$/, '');
  return t ? `#${t}` : '';
}
export const monthTag = (ts) => { const d = new Date(ts); return `#${d.getUTCFullYear()}_${p2(d.getUTCMonth() + 1)}`; };
export const idTag = (tag) => `#id_${tag}`;

const trim = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function stats(e) {
  const parts = e.kind === 'listing'
    ? [`📄 ${plural(e.files, 'file')}`]
    : [`📄 ${plural(e.pages, 'page')}`, `🗂 ${plural(Math.max(0, e.files - e.pages), 'file')}`];
  parts.push(`💾 ${size(e.bytes)}`);
  if (e.parts > 1) parts.push(`📚 ${e.parts} parts`);
  return parts.join(' · ');
}

const tagLine = (e) => [hashtag(e.host), monthTag(e.createdAt), idTag(e.tag), e.mode && /browser/.test(e.mode) ? '#dynamic' : '', e.kind === 'listing' ? '#files' : '#site'].filter(Boolean).join(' ');

// the main post of an archive item: the preview picture, or the first ZIP when there is no preview
export function mainCaption(e, { place }) {
  const head = e.kind === 'listing' ? `📂 ${b(esc(e.host))}\n${code(trim(e.title, 120))}` : `📦 ${b(esc(e.host))}${e.title ? `\n${esc(trim(e.title, 120))}` : ''}`;
  const where = place === 'vault'
    ? `🗄 ${i(`Archived ${shortDate(e.vaultedAt ?? e.createdAt)} from Live`)}`
    : `⏳ ${i(`Live until ${shortDate(e.liveExpiresAt ?? e.createdAt)}`)}`;
  return [head, `🗓 ${fullDate(e.createdAt)}`, stats(e), where, '', tagLine(e)].join('\n').slice(0, 1000);
}

// a ZIP that follows a preview, or any later part of a multi-part item
export function partCaption(e, { part, of }) {
  const head = of > 1 ? `📦 ${b(`Part ${part} of ${of}`)} · ${esc(e.host)}` : `📦 ${b(esc(e.fileName || `${e.host}.zip`))}`;
  return [head, `💾 ${size(e.sizes?.[part - 1] ?? e.bytes)}`, '', idTag(e.tag)].join('\n').slice(0, 1000);
}

// t.me link of a post in a channel or supergroup (works for members of a private chat)
export function postLink(chatId, msgId) {
  const s = String(chatId);
  return s.startsWith('-100') && msgId ? `https://t.me/c/${s.slice(4)}/${msgId}` : null;
}

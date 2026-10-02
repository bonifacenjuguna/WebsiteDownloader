// Interactive /help: a menu of topics, each topic made of pages. Pure functions (no Telegram imports)
// that return { text (HTML), rows: [[{ text, data }]] } so they are easy to test.
import { CFG } from './config.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hours = () => Math.max(1, Math.round(CFG.cacheTtlMs / 3600000));
const secs = (ms) => Math.round(ms / 1000);
const mbOf = (b) => Math.round(b / 1048576);

const MENU_TEXT = [
  '📖 <b>Website Downloader: Help</b>',
  '',
  'Tap a topic to read it. Use ◀ ▶ to flip through the pages and 🏠 to come back here.',
  '',
  'Quick start: just send me a link like <code>example.com</code>',
].join('\n');

// Order matters: the admin topic is last so page numbers are identical for everyone else.
const TOPICS = [
  {
    icon: '📥', title: 'Download a site',
    pages: () => [[
      'Send a link in any format:',
      '<code>example.com</code>',
      '<code>www.example.com/path</code>',
      '<code>https://sub.example.co.ke</code>',
      '',
      "I reply with a ZIP of the site's frontend (HTML, CSS, JS, images, fonts). Unzip it and open <code>index.html</code>.",
      '',
      '• JavaScript-heavy sites are rendered in a real browser automatically.',
      '• Analytics and ad trackers are stripped out.',
      `• Asking for the same site again within ${hours()}h is instant.`,
      '• Prefer a command? <code>/download example.com</code>',
    ].join('\n')],
  },
  {
    icon: '📂', title: 'Sections & folders',
    pages: () => [
      [
        '<code>/site &lt;url&gt;</code> saves more than one page at once. It works out what it is looking at:',
        '',
        '📄 <b>A section of pages</b>',
        '<code>/site example.com/docs</code>',
        `Follows links under that path, up to ${CFG.siteMaxPages} pages and ${CFG.siteDepth} levels deep. Links between the saved pages work offline.`,
        '',
        '📂 <b>An open folder listing</b> ("Index of /files/")',
        `Downloads every file and keeps the folders. Big listings arrive as up to ${CFG.siteMaxParts} ZIP parts: unzip them all into one folder.`,
      ].join('\n'),
      [
        '<b>Good to know</b>',
        '• Same site only. Links with <code>?query</code> and files like PDFs are not followed.',
        "• Pages that the site's robots.txt disallows are skipped.",
        '• Sites that build their pages with JavaScript cannot be followed. Use /browser for the page itself.',
        `• Limits: ${CFG.siteMaxPages} pages, ${CFG.siteMaxFiles} files and ${mbOf(CFG.siteMaxTotalBytes)} MB per listing, ${Math.round(CFG.siteTimeoutMs / 60000)} min.`,
        '• One /site counts as one download toward your daily limit.',
        '• Anything left out is listed in <code>skipped.txt</code> inside the ZIP.',
      ].join('\n'),
    ],
  },
  {
    icon: '🧭', title: 'Browser mode',
    pages: () => [[
      "Some sites show an empty page until JavaScript runs. I detect most of them, but if a result comes out empty or missing content:",
      '',
      '• Tap <b>🧭 Retry in browser mode</b> under the result (it appears when a page looks empty), or',
      '• Send <code>/browser example.com</code>',
      '',
      'I then load the site in a real browser and save what it shows.',
      '',
      '<b>You get two files:</b>',
      '• <code>index.html</code>: a snapshot that opens with a double-click',
      '• <code>index.original.html</code>: keeps the site\'s scripts. Run <code>npx serve</code> in the folder and open it to use the real app.',
    ].join('\n')],
  },
  {
    icon: '🖼', title: 'Previews',
    pages: () => [[
      'See a site before downloading it:',
      '',
      '• <code>/preview example.com</code>',
      '• or tap <b>🖼 Preview</b> under any result',
      '',
      'I send a screenshot of the <b>live</b> site (the top of the page). It is not the downloaded copy.',
      '',
      `Previews are cached for ${hours()}h, so repeats are instant.`,
    ].join('\n')],
  },
  {
    icon: '🕘', title: 'History & instant copies',
    pages: () => [[
      '<code>/history</code> lists your recent downloads. Tap one to get the file again instantly, with no re-download.',
      '',
      `Every download is kept for ${hours()}h. If you ask for a site I already have, I resend it right away and label it <b>⚡ Instant copy</b>.`,
      '',
      'Want the latest version of the site? Tap <b>🔄 Fresh copy</b> under the file.',
    ].join('\n')],
  },
  {
    icon: '⚖️', title: 'Limits',
    pages: () => [
      [
        '<b>Fair use</b>',
        '• One download at a time per person.',
        `• ${secs(CFG.cooldownMs)}s pause between new downloads.`,
        CFG.dailyLimit ? `• ${CFG.dailyLimit} new downloads per day (resets 00:00 UTC).` : '• No daily limit.',
        '• Cached copies and previews do not count towards these limits.',
        '• If I am busy you will be queued, and asked to retry if the queue is full.',
      ].join('\n'),
      [
        '<b>Size</b>',
        "• Telegram caps bot files at 50 MB, so a ZIP can't be bigger.",
        '• If a site is too heavy I leave out the biggest videos, then images, then fonts. I never remove code (HTML, CSS, JS).',
        `• Single files over ${mbOf(CFG.maxFileBytes)} MB are skipped.`,
        '• Whatever is left out is listed in <code>skipped.txt</code> inside the ZIP, and those links keep pointing to the live site.',
      ].join('\n'),
    ],
  },
  {
    icon: '🛠', title: 'Troubleshooting',
    pages: () => [
      [
        '<b>What the messages mean</b>',
        '🛡️ <b>Cloudflare challenge</b>: the site blocks automated visitors. Nothing I can do.',
        '🔒 <b>Password protected</b> / 🔐 <b>login page</b>: I can only save what is public. If it redirects to a login, I save the login page itself.',
        '❓ <b>Could not find / not found</b>: check the spelling of the address.',
        '🔓 <b>SSL certificate</b>: the site has a broken certificate.',
        '⏱️ <b>Took too long</b>: the site is slow or down. Try again later.',
        '🛑 <b>Private address</b>: local and internal addresses are blocked for safety.',
      ].join('\n'),
      [
        '<b>Result looks wrong?</b>',
        '• <b>Empty or unstyled page</b> → try /browser.',
        '• <b>Buttons or menus do nothing offline</b> → the site needs its server. Run <code>npx serve</code> in the unzipped folder and open it from there.',
        '• <b>Images missing</b> → they were too large or blocked. They still load from the live site when you are online.',
        '• <b>Not sure it is the right site</b> → check with /preview first.',
      ].join('\n'),
    ],
  },
  {
    icon: '🛡', title: 'Admin', admin: true,
    pages: () => [[
      '<b>Admin tools</b>',
      '• <code>/myid</code>: shows your Telegram ID',
      '• <code>/stats</code>: usage, speed per phase, top sites and failures',
      '• <code>/ban &lt;id&gt;</code> and <code>/unban &lt;id&gt;</code>',
      '',
      'Admins skip the cooldown, the one-at-a-time rule, the daily limit and bans, and cannot be banned.',
      '',
      'Admins are set with the <code>ADMIN_IDS</code> variable on the server.',
    ].join('\n')],
  },
];

function layout(admin) {
  const topics = TOPICS.filter((t) => admin || !t.admin);
  const flat = [];
  const starts = [];
  topics.forEach((topic) => {
    const pages = topic.pages();
    starts.push(flat.length);
    pages.forEach((text, pi) => flat.push({ topic, pi, count: pages.length, text }));
  });
  return { topics, flat, starts };
}

export const pageCount = (admin = false) => layout(admin).flat.length;

export function renderMenu(admin = false) {
  const { topics, starts } = layout(admin);
  const buttons = topics.map((t, i) => ({ text: `${t.icon} ${t.title}`, data: `hp:${starts[i]}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: '✖ Close', data: 'hp:x' }]);
  return { text: MENU_TEXT, rows };
}

export function renderPage(index, admin = false) {
  const { flat } = layout(admin);
  const i = Math.min(Math.max(Number.isInteger(index) ? index : 0, 0), flat.length - 1);
  const p = flat[i];
  const header = `<b>${p.topic.icon} ${esc(p.topic.title)}</b>${p.count > 1 ? `  <i>(${p.pi + 1}/${p.count})</i>` : ''}\n\n`;
  const nav = [];
  if (i > 0) nav.push({ text: '◀ Prev', data: `hp:${i - 1}` });
  nav.push({ text: `📖 ${i + 1}/${flat.length}`, data: 'hp:n' });
  if (i < flat.length - 1) nav.push({ text: 'Next ▶', data: `hp:${i + 1}` });
  return {
    text: header + p.text,
    rows: [nav, [{ text: '🏠 Menu', data: 'hp:m' }, { text: '✖ Close', data: 'hp:x' }]],
    index: i,
  };
}

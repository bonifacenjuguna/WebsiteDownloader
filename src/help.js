// Interactive /help: a menu of topics, each topic made of pages. Pure functions (no Telegram imports)
// that return { text (HTML), rows: [[{ text, data }]] } so they are easy to test.
import { CFG } from './config.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hours = () => Math.max(1, Math.round(CFG.cacheTtlMs / 3600000));
const secs = (ms) => Math.round(ms / 1000);
const mbOf = (b) => Math.round(b / 1048576);

// "What can this bot do?": grouped by what you can accomplish, not by how it works
const MENU_TEXT = [
  '📖 <b>What I can do</b>',
  '',
  '🌐 Save websites for offline use',
  '📂 Whole sites with every page, plus open folders',
  '🧠 Handles dynamic sites automatically',
  '🖼 Preview a live page before downloading',
  '📜 Revisit (or clear) previous downloads',
  '🔄 Refresh saved copies when needed',
  '',
  'Send a link to begin, or pick a topic below.',
].join('\n');

// Order matters: the admin topic is last so page numbers are identical for everyone else.
const TOPICS = [
  {
    icon: '🌐', title: 'Save a website',
    pages: () => [[
      'Send a link in any format:',
      '<code>example.com</code>',
      '<code>www.example.com/page</code>',
      '<code>https://sub.example.co.ke</code>',
      '',
      "I'll send back a ZIP. Unzip it and open <code>index.html</code>. The site works offline.",
      '',
      '• Dynamic and protected sites are handled automatically. I pick the best way in.',
      '• Ads and trackers are left out.',
      `• Asking for the same site again within ${hours()}h is instant.`,
      '',
      'Prefer a command? <code>/download example.com</code>',
    ].join('\n')],
  },
  {
    icon: '📂', title: 'Whole sites & folders',
    pages: () => [
      [
        'Send a link and I save the <b>whole site</b>: every page, image, style and linked document, all connected so you can click around offline.',
        '',
        '<code>example.com</code> saves the entire site.',
        '<code>example.com/docs</code> saves just that part of it.',
        '',
        '📦 <b>Big sites arrive as several ZIPs.</b> Unzip them all into the same folder (merge when asked), then open <code>index.html</code>.',
        '',
        '📂 Links that open a plain file list (\"Index of /files/\") are downloaded as files, keeping the folders.',
      ].join('\n'),
      [
        '<b>Good to know</b>',
        `• Up to ${CFG.siteMaxPages} pages per site (${CFG.siteMaxPagesBrowser} for sites that build pages with JavaScript), in about ${Math.round(CFG.siteTimeoutMs / 60000)} minutes.`,
        '• I stay on the same site and use its sitemap to find pages. Links with search filters (like ?page=2) are not followed.',
        '• Every link is checked before sending, and <code>_all-pages.html</code> lists all saved pages.',
        '• Pages a site asks bots not to copy are skipped.',
        '• PDFs, documents and media linked from pages are included.',
        '• One link counts as one download toward your daily limit.',
        '• Anything left out is listed in <code>skipped.txt</code> inside the first ZIP.',
      ].join('\n'),
    ],
  },
  {
    icon: '🖼', title: 'Previews',
    pages: () => [[
      'Take a look before you download:',
      '',
      '• <code>/preview example.com</code>',
      '• or tap <b>🖼 Preview</b> under any result',
      '',
      'You get a screenshot of the live page as it is right now, not your saved copy.',
    ].join('\n')],
  },
  {
    icon: '📜', title: 'History & privacy',
    pages: () => [
      [
        '<code>/history</code> shows your recent downloads. Tap one to get it again instantly. Tap <b>✖</b> next to one to remove it, or <b>🗑 Clear history</b> to remove them all.',
        '',
        `Saved copies are kept for ${hours()}h. Ask for a site I already have and it arrives right away, marked <b>⚡ Instant copy</b>. After that, I quickly check the site and, if nothing changed, send the same copy again instead of rebuilding.`,
        '',
        'Want the latest version? Tap <b>🔄 Fresh copy</b> under the file. If nothing changed on the site, you get the same copy back at once.',
      ].join('\n'),
      [
        '<b>Your data</b>',
        '<code>/privacy</code> shows what I keep and lets you:',
        '• choose when your history is deleted automatically (7 days, 30 days, never)',
        '• delete all your data in one tap',
        '',
        '<code>/language</code> changes the language of my messages. I use your Telegram language by default.',
      ].join('\n'),
    ],
  },
  {
    icon: '⚖️', title: 'Limits',
    pages: () => [
      [
        '<b>Fair use</b>',
        '• One download at a time.',
        `• A short pause (${secs(CFG.cooldownMs)}s) between new downloads.`,
        CFG.dailyLimit ? `• ${CFG.dailyLimit} new downloads per day. It resets at midnight UTC.` : '• No daily limit.',
        '• Instant copies and previews are not counted.',
        "• If I'm busy, you'll be put in a queue.",
      ].join('\n'),
      [
        '<b>Size</b>',
        '• Telegram limits each file to 50 MB, so big sites are sent as several ZIPs of about 40 MB each.',
        `• Up to ${CFG.siteMaxParts} ZIPs per site. If a site is bigger, I leave out the largest videos and images first. Pages and code are never cut.`,
        `• Single files over ${mbOf(CFG.maxFileBytes)} MB are skipped.`,
        '• Anything left out is listed in <code>skipped.txt</code>, and still loads from the live site when you are online.',
      ].join('\n'),
    ],
  },
  {
    icon: '🛟', title: 'Troubleshooting',
    pages: () => [
      [
        '<b>What the messages mean</b>',
        '🛡️ <b>Protected</b>: the site blocks automated downloads, even through a real browser.',
        '🌍 <b>Region</b>: the site is not available from where I run.',
        '🔐 <b>Sign-in</b>: only the public page can be saved.',
        '❓ <b>Not found</b>: check the address for typos.',
        '⏳ <b>Slow or busy</b>: try again in a few minutes.',
        '🛑 <b>Private address</b>: local and internal addresses are not allowed.',
      ].join('\n'),
      [
        '<b>Copy looks off?</b>',
        '• <b>Empty or unstyled</b>: send the link again with 🔄 Fresh copy. Dynamic sites are retried automatically.',
        '• <b>Menus or buttons do nothing</b>: the site needs its server. Run <code>npx serve</code> in the unzipped folder and open it from there (see README.txt).',
        '• <b>Images missing</b>: they were too large or blocked. They load from the live site when you are online.',
        '• <b>Not sure it is the right site</b>: use 🖼 Preview first.',
      ].join('\n'),
    ],
  },
  {
    icon: '🛡', title: 'Admin', admin: true,
    pages: () => [[
      '<b>Admin tools</b>',
      '• <code>/myid</code>: your Telegram ID',
      '• <code>/ping</code>: is it alive? uptime, memory and speed',
      '• <code>/stats</code>: usage, speed and common problems',
      '• <code>/ban &lt;id&gt;</code> and <code>/unban &lt;id&gt;</code>',
      '',
      'Admins skip the pause between downloads, the daily limit and bans, and cannot be banned.',
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

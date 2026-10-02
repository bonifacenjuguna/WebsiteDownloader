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
  '📂 Download folders and website sections',
  '🧭 Capture dynamic pages with browser mode',
  '🖼 Preview a live page before downloading',
  '📜 Revisit previous downloads',
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
      '• Dynamic sites are handled automatically.',
      '• Ads and trackers are left out.',
      `• Asking for the same site again within ${hours()}h is instant.`,
      '',
      'Prefer a command? <code>/download example.com</code>',
    ].join('\n')],
  },
  {
    icon: '📂', title: 'Sections & folders',
    pages: () => [
      [
        'Use <code>/site</code> to save more than one page at once. I work out what the link is:',
        '',
        '📄 <b>A section of a site</b>',
        '<code>/site example.com/docs</code>',
        `I follow the links in that section (up to ${CFG.siteMaxPages} pages) and keep them connected, so you can click around offline.`,
        '',
        '📂 <b>A folder of files</b>',
        'If the link opens a plain file list ("Index of /files/"), I download the files and keep the folders. Big folders arrive as several ZIPs: unzip them all into one folder.',
      ].join('\n'),
      [
        '<b>Good to know</b>',
        '• I stay on the same site and skip PDFs, images and links with search filters.',
        '• Pages that a site asks bots not to copy are skipped.',
        '• Sites that load their pages dynamically can only be saved one page at a time, using browser mode.',
        `• Up to ${CFG.siteMaxPages} pages, or ${CFG.siteMaxFiles} files and ${mbOf(CFG.siteMaxTotalBytes)} MB per folder, in about ${Math.round(CFG.siteTimeoutMs / 60000)} minutes.`,
        '• One /site counts as one download toward your daily limit.',
        '• Anything left out is listed in <code>skipped.txt</code> inside the ZIP.',
      ].join('\n'),
    ],
  },
  {
    icon: '🧭', title: 'Browser mode',
    pages: () => [[
      'Some sites show very little until they finish loading. If a copy comes out empty or incomplete, tap <b>🧭 Browser mode</b> under the result, or send:',
      '<code>/browser example.com</code>',
      '',
      "I'll capture the page the way you'd see it in a browser.",
      '',
      '<b>You get two files:</b>',
      '• <code>index.html</code>: opens with a double-click',
      "• <code>index.original.html</code>: keeps the site's interactive features (see README.txt)",
    ].join('\n')],
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
    icon: '📜', title: 'History',
    pages: () => [[
      '<code>/history</code> shows your recent downloads. Tap one to get it again instantly.',
      '',
      `Saved copies are kept for ${hours()}h. Ask for a site I already have and it arrives right away, marked <b>⚡ Instant copy</b>.`,
      '',
      'Want the latest version? Tap <b>🔄 Fresh copy</b> under the file.',
    ].join('\n')],
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
        '• Telegram limits files to 50 MB.',
        '• If a site is too big, I leave out the largest videos, images and fonts first. The site itself is never cut.',
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
        '🛡️ <b>Protected</b>: the site blocks automated downloads.',
        '🔐 <b>Sign-in</b>: only the public page can be saved.',
        '❓ <b>Not found</b>: check the address for typos.',
        '⏳ <b>Slow or busy</b>: try again in a few minutes.',
        '🛑 <b>Private address</b>: local and internal addresses are not allowed.',
      ].join('\n'),
      [
        '<b>Copy looks off?</b>',
        '• <b>Empty or unstyled</b>: try 🧭 Browser mode.',
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

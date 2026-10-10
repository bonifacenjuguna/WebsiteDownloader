// Everything the user reads lives here (plus help.js and profile.js), in English, and is translated by locales/*.js.
// The backend keeps precise error codes, HTTP statuses and technical messages for logs and analytics;
// this file turns them into short, human language and decides which actions are worth showing.
// Use tr(lang) to get the wording for one language. Missing translations fall back to English, key by key.
import { MB } from './config.js';
import { UserError } from './errors.js';
import { esc, b, i, code, titled, styleError } from './fmt.js';
import { LOCALES } from './locales/index.js';

const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
export const size = (b) => (b < 0.1 * MB ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / MB).toFixed(1)} MB`);

export const LANGS = { en: 'English', es: 'Español', fr: 'Français', pt: 'Português', de: 'Deutsch', ru: 'Русский', sw: 'Kiswahili' };
// Telegram's language_code ("pt-br", "es", ...) -> one of ours
export const mapLang = (code) => {
  const c = String(code || '').toLowerCase().split(/[-_]/)[0];
  return LANGS[c] ? c : 'en';
};

const bar = (done, total, width = 10) => {
  const n = Math.max(0, Math.min(width, Math.round((done / Math.max(1, total)) * width)));
  return `${'▰'.repeat(n)}${'▱'.repeat(width - n)}`;
};
const withBar = (line, done, total) => (total ? `${line}\n<code>${bar(done, total)}</code>  ${Math.min(100, Math.round((done / Math.max(1, total)) * 100))}%` : line);

// ---------------------------------------------------------------- English (the base language)
const EN = {
  START_TEXT: [
    '👋 <b>Welcome to Website Downloader</b>',
    '',
    "Save any website for offline use. Send me a link and I'll send back a ZIP. Unzip it, open <code>index.html</code>, and the site works without internet.",
    '',
    'Try it now. Just send a link like:',
    '<code>example.com</code>',
    '',
    'I save the whole site: every page, image and file, all linked together. Big sites arrive as several ZIPs (unzip them all into one folder). Tap Help to see everything I can do.',
  ].join('\n'),

  // ---- progress (one message, edited in place)
  STATUS: {
    starting: (host) => `⏳ Saving ${b(host)}…`,
    queued: (pos) => `⏳ ${b(`You're #${pos} in line`)}\n${i('I will start as soon as a slot is free.')}`,
    shared: "⏳ This site is already being saved. You'll get it in a moment.",
    opening: (host) => `🌐 Opening ${b(host)}…`,
    mapping: '🗺️ Mapping the site…',
    browser: '🧭 Loading the full page…',
    browser2: '🧭 Trying another way in…',
    assets: (done, total) => withBar(total ? `📦 ${b('Collecting files')}  ${done}/${total}` : `📦 ${b('Collecting files')}…`, done, total),
    checking: '🔎 Checking links…',
    zip: '🗜️ Packing your ZIP…',
    sending: (i = 1, n = 1) => (n > 1 ? `📤 Sending part ${i}/${n}…` : '📤 Sending…'),
    folders: (folders, files) => `📂 Looking through folders… (${folders} ${plural(folders, 'folder')}, ${files} ${plural(files, 'file')})`,
    files: (done, total) => withBar(`📥 ${b('Downloading files')}  ${done}/${total}`, done, total),
    pages: (done, total) => withBar(`📄 ${b('Saving pages')}  ${done}/${total}`, done, total),
    preview: '🖼 Capturing a preview…',
    resuming: '🔄 I was restarted. Picking up where I left off…',
    cancelling: '🛑 Cancelling…',
    cancelled: '🛑 Cancelled.',
    changes: '🔎 Checking whether anything changed…',
  },

  // ---- buttons
  BTN: {
    cancel: '✖ Cancel',
    preview: '🖼 Preview',
    fresh: '🔄 Fresh copy',
    retry: '🔁 Try again',
    clearAll: '🗑 Clear history',
    yesClear: 'Yes, clear it',
    keep: 'Keep it',
    deleteData: '🗑 Delete all my data',
    yesDelete: 'Yes, delete everything',
    help: '📖 Help',
    back: '◀ Back',
  },

  // ---- short notes under a result (coded in the backend, worded here)
  NOTE: {
    signIn: () => '🔐 This page requires a sign-in, so only the public page was saved.',
    restricted: () => '🔒 This site limits automated access, so this is the public page it shows visitors.',
    signInForm: () => "🔐 There's a sign-in form here. Anything behind it isn't included.",
    loginPages: (n) => `🔐 ${n} ${plural(n, 'page needs', 'pages need')} a sign-in and ${plural(n, 'was', 'were')} left out.`,
    pageLimit: (n) => `📄 This site has more pages than I can save at once, so I saved the first ${n}.`,
    overflow: (n) => `📦 ${n} ${plural(n, 'file', 'files')} didn't fit in the ZIP parts and ${plural(n, 'was', 'were')} left out.`,
    robots: (n) => `🤖 ${n} ${plural(n, 'page was', 'pages were')} skipped because the site asks bots not to copy ${plural(n, 'it', 'them')}.`,
    slow: () => '⏱️ This site was slow to respond, so a few files may be missing.',
    browserFallback: () => '💡 Some dynamic content may be missing from this copy.',
    compressed: (n) => `🗜️ ${n} large ${plural(n, 'image was', 'images were')} compressed to fit.`,
    missing: (n) => `📎 ${n} ${plural(n, 'file')} couldn't be included. Details are in skipped.txt.`,
  },

  // ---- words used in captions and footers
  CAP: {
    pages: (n) => `${n} ${plural(n, 'page')}`,
    files: (n) => `${n} ${plural(n, 'file')}`,
    folders: (n) => `${n} ${plural(n, 'folder')}`,
    part: (i, n) => `📦 Part ${i} of ${n}`,
    partsHint: (n) => `📦 Sent as ${n} ZIPs. Unzip them all into one folder, then open ${code('index.html')}.`,
    justNow: 'just now',
    mAgo: (m) => `${m}m ago`,
    hAgo: (h) => `${h}h ago`,
    dAgo: (d) => `${d}d ago`,
    footer: (kind, ago) => `⚡ ${{ history: 'From your history', unchanged: 'Still up to date', cache: 'Instant copy' }[kind] || 'Instant copy'} · saved ${ago}`,
  },

  // ---- errors: backend code -> human text
  ERRORS: {
    invalid_url: "❌ That doesn't look like a website address. Try something like example.com",
    blocked_address: "🛑 That address is private, so it can't be downloaded.",
    blocked_domain: "🚫 This website can't be downloaded with this bot.",
    dns: "❓ I couldn't find that website. Check the address and try again.",
    not_found: "❓ That page couldn't be found. Check the URL and try again.",
    forbidden: "🔒 This site isn't allowing automated access.",
    auth: "🔒 This site is password protected, so it couldn't be downloaded.",
    cloudflare: "🛡️ This site is protected and couldn't be downloaded.",
    bot_blocked: "🤖 This site blocks automated visitors, even through a real browser, so it couldn't be downloaded.",
    geo_blocked: "🌍 This site isn't available from the region I run in, so it couldn't be downloaded.",
    rate_limited: '⏳ This site is temporarily limiting requests. Try again shortly.',
    server_error: '💥 This site seems to be having problems right now. Try again in a little while.',
    http_error: '⚠️ This site gave an unexpected response. Try again later.',
    timeout: '⏱️ This site is taking too long to respond. Try again in a moment.',
    refused: "🚫 This site isn't accepting connections right now. Try again later.",
    reset: "🚫 This site isn't accepting connections right now. Try again later.",
    ssl: "🔓 This site's security certificate isn't valid, so it couldn't be saved.",
    redirects: '🔁 This site keeps redirecting and never settles on a page.',
    network: "⚠️ I couldn't reach this site. Try again in a moment.",
    not_html: "📄 That link is a file rather than a web page. Send the page's address instead.",
    too_large: '📏 That page is too large to save.',
    zip_too_big: '📦 This one is too large to send through Telegram, even without its images and videos.',
    send_failed: "⚠️ I couldn't send the file. Please try again.",
    empty_listing: "📂 I couldn't find any files in that folder.",
    listing_unsavable: '📂 None of the files in that folder could be saved. They may be too large for Telegram.',
    queue_full: "🚦 I'm busy right now. Please try again in a minute.",
    cancelled: '🛑 Cancelled.',
    internal: '❌ Something went wrong. Please try again.',
  },

  // ---- small messages
  MSG: {
    notAuthorized: "🔒 This bot is private, so I can't help you here.",
    banned: '🚫 Your access to this bot has been turned off.',
    busy: "⏳ Your last download is still running. I'll send it as soon as it's ready.",
    cooldown: (s) => `⏳ Give me a moment. You can send the next link in ${s}s.`,
    daily: (n) => `📅 You've reached today's limit of ${n} new downloads. It resets at midnight UTC. Sites I've already saved and previews still work.`,
    domainCap: (n, host) => `📅 You've saved ${b(esc(host))} ${n} times today. Try again tomorrow, or use the copy you already have in /history.`,
    siteBusyToday: (host) => `📅 ${b(esc(host))} has been saved many times today already. Try again tomorrow.`,
    paused: (min) => `⏸ Several attempts in a row didn't work out, so I'm pausing for about ${min} min. Please check the addresses and try again after that.`,
    retrySoon: '⏳ I just checked this one. Give it a few minutes, or tap Try again.',
    moreLinks: (n) => `🔗 I found ${n} links. I'm saving the first one. Send the others one at a time.`,
    noLink: `I couldn't find a website address in that message. Send a link like ${code('example.com')}`,
    unchanged: "✅ Nothing has changed on this site since I saved it, so here's the same copy.",
    cancelNone: 'That job has already finished.',
    restartLost: (host) => `⚠️ I was restarted while saving ${b(esc(host))} and couldn't finish. Please send the link again.`,
    cancelOthers: "Others asked for this site too, so I'll finish it.",
    // history
    historyOff: "📜 History isn't available right now.",
    historyEmpty: '📜 Nothing here yet. Send me a link to get started.',
    historyTitle: '📜 Your recent downloads\nTap one to get it again. ✖ removes it from your history.',
    historyAsk: '🗑 Clear your whole history?\nThis removes the list of sites you asked for. Files you already received stay in your chat.',
    historyCleared: '🗑 History cleared.',
    fileGone: "That file isn't available anymore. Send the link again to get a fresh copy.",
    refreshLost: 'Send the link again to refresh it.',
    previewLost: 'Send the link again and tap 🖼 Preview.',
    previewOff: "🖼 Previews aren't available right now.",
    previewWait: '⏳ One preview at a time. Try again in a few seconds.',
    previewFail: "🖼 I couldn't capture a preview of that page.",
    usageDownload: `Send /download followed by a link, for example:\n${code('/download example.com')}`,
    usagePreview: `Send /preview followed by a link, for example:\n${code('/preview example.com')}`,
    // privacy
    privacy: (retention) => [
      '🔒 <b>Privacy</b>',
      '',
      'I keep the addresses you ask for, linked to your Telegram ID, so you can find them in /history. I never ask for or store passwords or cookies.',
      '',
      `🕒 Auto-delete: <b>${retention}</b>`,
      '<i>Choose how long your history is kept:</i>',
    ].join('\n'),
    retention: { def: (d) => `Default (${d} days)`, d7: '7 days', d30: '30 days', never: 'Never' },
    retentionSet: (label) => `✅ Auto-delete set to: ${label}.`,
    deleteAsk: '🗑 Delete all your data?\nYour history, name and settings are removed. This cannot be undone.',
    deleted: '🗑 Done. Your history and settings were deleted.',
    langPick: '🌐 Choose your language:',
    langSet: (name) => `✅ Language: ${name}`,
    langAuto: '🌐 Automatic (Telegram language)',
    // admin
    adminOnly: '🔒 This command is for admins only.',
    adminOff: "🔒 Admin commands aren't set up yet. The owner can enable them with ADMIN_IDS (send /myid to get your ID).",
    adminSelf: "🛡️ Admins can't be banned (that includes you).",
  },
};

// ---------------------------------------------------------------- per-language bundles
const SECTIONS = ['STATUS', 'BTN', 'NOTE', 'CAP', 'ERRORS', 'MSG'];
const bundles = new Map();

export function tr(lang = 'en') {
  const code = LOCALES[lang] ? lang : 'en';
  if (bundles.has(code)) return bundles.get(code);
  const loc = LOCALES[code] || {};
  const L = { lang: code, START_TEXT: loc.START_TEXT || EN.START_TEXT };
  for (const s of SECTIONS) L[s] = { ...EN[s], ...(loc[s] || {}) };
  L.MSG.retention = { ...EN.MSG.retention, ...(loc.MSG?.retention || {}) };

  // translated progress lines get the progress bar too
  for (const k of ['assets', 'pages', 'files']) {
    const f = loc.STATUS?.[k];
    if (f) L.STATUS[k] = (d, t) => withBar(f(d, t), d, t);
  }
  // consistent look in every language: errors = bold first sentence + detail; list headers = bold title + italic hint
  const styled = {};
  for (const [k, v] of Object.entries(L.ERRORS)) styled[k] = styleError(v);
  L.ERRORS = styled;
  for (const k of ['historyTitle', 'historyAsk', 'deleteAsk']) L.MSG[k] = titled(L.MSG[k]);
  L.errorText = (c) => L.ERRORS[c] || L.ERRORS.internal;
  L.ago = (ms) => {
    const m = Math.floor(ms / 60000);
    if (m < 1) return L.CAP.justNow;
    if (m < 60) return L.CAP.mAgo(m);
    const h = Math.floor(m / 60);
    return h < 48 ? L.CAP.hAgo(h) : L.CAP.dAgo(Math.floor(h / 24));
  };
  L.previewCaption = (host) => `🖼 ${b(esc(host))}\n${i(loc.previewLine || 'Live preview of the page as it is right now.')}`;
  // buttons under a result: only what makes sense (a fresh copy only for a saved copy)
  L.actionsFor = ({ refresh = false } = {}) => [...(refresh ? [{ text: L.BTN.fresh, cb: 'r' }] : []), { text: L.BTN.preview, cb: 'p' }];
  L.failureActions = (code) => (RETRY_CODES.has(code) ? [{ text: L.BTN.retry, cb: 'r' }] : []);
  L.caption = (stored) => renderCaption(L, stored);
  bundles.set(code, L);
  return L;
}

// ---------------------------------------------------------------- result caption
// ✅ domain / 📝 title / 📦 files • size / at most ONE short note. Stored as JSON so every reader sees it in their own language.
const NOTE_ORDER = ['signIn', 'restricted', 'signInForm', 'loginPages', 'pageLimit', 'overflow', 'robots', 'slow', 'browserFallback', 'compressed', 'missing'];

export function buildSummary(r, nParts = 1) {
  const notes = [...(r.warnings || [])];
  const missing = (r.skipped || 0) + (r.failed || 0);
  // a couple of missing images isn't news; only mention it when it's a meaningful share
  if (missing > 0 && (missing >= 3 || missing / (r.fileCount + missing) >= 0.1)) notes.push({ c: 'missing', n: missing });
  return {
    v: 1, kind: r.kind, host: r.host, title: r.title || '', pages: r.pages || 0, files: r.fileCount || 0,
    dirs: r.dirCount || 0, bytes: r.zipBytes || 0, parts: nParts, notes,
  };
}

export const parseSummary = (stored) => {
  if (typeof stored !== 'string' || stored[0] !== '{') return null;
  try { const s = JSON.parse(stored); return s?.v === 1 ? s : null; } catch { return null; }
};

export function renderCaption(L, stored) {
  const s = parseSummary(stored);
  if (!s) return String(stored || ''); // captions saved by older versions are plain text
  const dot = '  ·  ';
  const lines = [`✅ ${b(esc(s.host))}`];
  if (s.kind === 'listing') {
    lines.push(`📂 ${code(s.title)}`, '', `📄 ${L.CAP.files(s.files)}${dot}🗂 ${L.CAP.folders(s.dirs)}${dot}💾 ${size(s.bytes)}`);
  } else {
    if (s.title) lines.push(esc(s.title));
    const assets = Math.max(0, s.files - s.pages);
    lines.push('', `📄 ${L.CAP.pages(s.pages)}${dot}🗂 ${L.CAP.files(assets)}${dot}💾 ${size(s.bytes)}`);
  }
  const note = NOTE_ORDER.map((c) => s.notes.find((n) => n.c === c)).find(Boolean);
  if (note && L.NOTE[note.c]) lines.push('', i(L.NOTE[note.c](note.n)));
  return lines.join('\n').slice(0, 900);
}

// ---------------------------------------------------------------- errors
export const codeOf = (e) => (e instanceof UserError ? e.code : e?.message === 'QUEUE_FULL' ? 'queue_full' : 'internal');

// worth offering "Try again" (the problem may be temporary)
export const RETRY_CODES = new Set(['timeout', 'refused', 'reset', 'network', 'server_error', 'rate_limited', 'http_error', 'redirects', 'queue_full', 'send_failed']);

export const ENGLISH = EN; // for tests

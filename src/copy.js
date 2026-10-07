// Everything the user reads lives here (plus help.js and profile.js).
// The backend keeps precise error codes, HTTP statuses and technical messages for logs and analytics;
// this file turns them into short, human language and decides which actions are worth showing.
import { MB } from './config.js';
import { UserError } from './errors.js';

const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
export const size = (b) => (b < 0.1 * MB ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / MB).toFixed(1)} MB`);

// ---------------------------------------------------------------- /start
export const START_TEXT = [
  '👋 <b>Welcome to Website Downloader</b>',
  '',
  "Save any website for offline use. Send me a link and I'll send back a ZIP. Unzip it, open <code>index.html</code>, and the site works without internet.",
  '',
  'Try it now. Just send a link like:',
  '<code>example.com</code>',
  '',
  'I save the whole site: every page, image and file, all linked together. Big sites arrive as several ZIPs (unzip them all into one folder). Tap Help to see everything I can do.',
].join('\n');

// ---------------------------------------------------------------- progress
export const STATUS = {
  starting: (host) => `⏳ Saving ${host}…`,
  queued: (ahead) => `⏳ In the queue (${ahead} ahead of you)…`,
  shared: "⏳ This site is already being saved. You'll get it in a moment.",
  opening: (host) => `🌐 Opening ${host}…`,
  browser: '🧭 Loading the full page…',
  assets: (done, total) => (total ? `📦 Collecting files… ${done}/${total}` : '📦 Collecting files…'),
  zip: '🗜️ Packing your ZIP…',
  sending: (i = 1, n = 1) => (n > 1 ? `📤 Sending part ${i}/${n}…` : '📤 Sending…'),
  folders: (folders, files) => `📂 Looking through folders… (${folders} ${plural(folders, 'folder')}, ${files} ${plural(files, 'file')})`,
  files: (done, total) => `📥 Downloading files… ${done}/${total}`,
  pages: (done, total) => `📄 Saving pages… ${done}/${total}`,
  preview: '🖼 Capturing a preview…',
};

// ---------------------------------------------------------------- short notes under a result
export const THIN_MARK = 'loads much of its content after opening'; // lets cached results remember they were thin
export const NOTES = {
  thin: `💡 This site ${THIN_MARK}. Try browser mode for a closer copy.`,
  parts: (n) => `📦 Sent in ${n} parts. Unzip them all into one folder.`,
  trimmed: (n) => `✂️ ${n} large ${plural(n, 'file was', 'files were')} left out to keep the ZIP within Telegram's size limit.`,
  slow: '⏱️ This site was slow to respond, so a few files may be missing.',
  browserFallback: '💡 Some dynamic content may be missing from this copy.',
  pageLimit: (n) => `📄 This site has more pages than I can save at once, so I saved the first ${n}.`,
  robots: (n) => `🤖 ${n} ${plural(n, 'page was', 'pages were')} skipped because the site asks bots not to copy ${plural(n, 'it', 'them')}.`,
  overflow: (n) => `📦 ${n} ${plural(n, 'file', 'files')} didn't fit in the ZIP parts and ${plural(n, 'was', 'were')} left out.`,
  missing: (n) => `📎 ${n} ${plural(n, 'file')} couldn't be included. Details are in skipped.txt.`,
  signIn: '🔐 This page requires a sign-in, so only the public page was saved.',
  restricted: '🔒 This site limits automated access, so this is the public page it shows visitors.',
  signInForm: "🔐 There's a sign-in form here. Anything behind it isn't included.",
};

// ---------------------------------------------------------------- result caption
// ✅ domain / 📝 title / 📦 files • size / at most two short notes
export function buildCaption(r, nParts = 1) {
  const lines = [`✅ ${r.host}`];
  if (r.kind === 'listing') {
    lines.push(`📂 ${r.title}`, '', `📦 ${r.fileCount} ${plural(r.fileCount, 'file')} in ${r.dirCount} ${plural(r.dirCount, 'folder')} • ${size(r.zipBytes)}`);
  } else if (r.kind === 'pages') {
    if (r.title) lines.push(`📝 ${r.title}`);
    const assets = Math.max(0, r.fileCount - r.pages);
    lines.push('', `📦 ${r.pages} ${plural(r.pages, 'page')} • ${assets} ${plural(assets, 'file')} • ${size(r.zipBytes)}`);
  } else {
    if (r.title) lines.push(`📝 ${r.title}`);
    lines.push('', `📦 ${r.fileCount} ${plural(r.fileCount, 'file')} • ${size(r.zipBytes)}`);
  }
  const notes = [];
  if (nParts > 1) notes.push(NOTES.parts(nParts));
  if (r.thin) notes.push(NOTES.thin);
  notes.push(...(r.warnings || []));
  const missing = (r.skipped || 0) + (r.failed || 0);
  // a couple of missing images isn't news; only mention it when it's a meaningful share
  if (!notes.length && missing > 0 && (missing >= 3 || missing / (r.fileCount + missing) >= 0.1)) notes.push(NOTES.missing(missing));
  if (notes.length) lines.push('', ...notes.slice(0, 2));
  return lines.join('\n').slice(0, 900);
}

export const previewCaption = (host) => `🖼 ${host}\nLive preview of the page as it is right now.`;

// ---------------------------------------------------------------- buttons (progressive disclosure)
// Only offer what makes sense for this result: browser mode when the copy looks thin, a fresh copy when it is cached.
export function actionsFor({ refresh = false, thin = false } = {}) {
  const a = [];
  if (thin) a.push({ text: '🧭 Browser mode', cb: 'b' });
  if (refresh) a.push({ text: '🔄 Fresh copy', cb: 'r' });
  a.push({ text: '🖼 Preview', cb: 'p' });
  return a;
}

// ---------------------------------------------------------------- errors: backend code -> human text
export const ERRORS = {
  invalid_url: "❌ That doesn't look like a website address. Try something like example.com",
  blocked_address: "🛑 That address is private, so it can't be downloaded.",
  dns: "❓ I couldn't find that website. Check the address and try again.",
  not_found: "❓ That page couldn't be found. Check the URL and try again.",
  forbidden: "🔒 This site isn't allowing automated access.",
  auth: "🔒 This site is password protected, so it couldn't be downloaded.",
  cloudflare: "🛡️ This site is protected and couldn't be downloaded.",
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
  zip_too_big: "📦 This one is too large to send through Telegram, even without its images and videos.",
  browser_failed: "🧭 I couldn't load this site in browser mode. Try again later.",
  browser_disabled: "🧭 Browser mode isn't available right now.",
  send_failed: "⚠️ I couldn't send the file. Please try again.",
  empty_listing: "📂 I couldn't find any files in that folder.",
  listing_unsavable: '📂 None of the files in that folder could be saved. They may be too large for Telegram.',
  queue_full: "🚦 I'm busy right now. Please try again in a minute.",
  internal: '❌ Something went wrong. Please try again.',
};

export const codeOf = (e) => (e instanceof UserError ? e.code : e?.message === 'QUEUE_FULL' ? 'queue_full' : 'internal');
export const errorText = (code) => ERRORS[code] || ERRORS.internal;

// worth offering "Try again" (the problem may be temporary)
export const RETRY_CODES = new Set(['timeout', 'refused', 'reset', 'network', 'server_error', 'rate_limited', 'http_error', 'redirects', 'queue_full', 'send_failed', 'browser_failed']);
export const BROWSER_CODES = new Set();

// the single most useful alternative for a failure, never a wall of options
export function failureActions(code) {
  if (BROWSER_CODES.has(code)) return [{ text: '🧭 Browser mode', cb: 'b' }];
  if (RETRY_CODES.has(code)) return [{ text: '🔁 Try again', cb: 'r' }];
  return [];
}

// ---------------------------------------------------------------- small messages
export const MSG = {
  notAuthorized: "🔒 This bot is private, so I can't help you here.",
  banned: '🚫 Your access to this bot has been turned off.',
  busy: "⏳ Your last download is still running. I'll send it as soon as it's ready.",
  cooldown: (s) => `⏳ Give me a moment. You can send the next link in ${s}s.`,
  daily: (n) => `📅 You've reached today's limit of ${n} new downloads. It resets at midnight UTC. Sites I've already saved and previews still work.`,
  retrySoon: '⏳ I just checked this one. Give it a few minutes, or tap Try again.',
  historyOff: "📜 History isn't available right now.",
  historyEmpty: '📜 Nothing here yet. Send me a link to get started.',
  historyTitle: '📜 Your recent downloads\nTap one to get it again instantly.',
  fileGone: "That file isn't available anymore. Send the link again to get a fresh copy.",
  refreshLost: 'Send the link again to refresh it.',
  previewLost: 'Send the link again and tap 🖼 Preview.',
  browserLost: 'Send the link again with /browser to try it.',
  browserOff: "🧭 Browser mode isn't available right now.",
  previewOff: "🖼 Previews aren't available right now.",
  previewWait: '⏳ One preview at a time. Try again in a few seconds.',
  previewFail: "🖼 I couldn't capture a preview of that page.",
  usageDownload: 'Send /download followed by a link, for example:\n/download example.com',
  usageBrowser: 'Send /browser followed by a link, for example:\n/browser example.com\n\nUse it when a saved copy comes out empty or incomplete.',
  usagePreview: 'Send /preview followed by a link, for example:\n/preview example.com',
  adminOnly: '🔒 This command is for admins only.',
  adminOff: "🔒 Admin commands aren't set up yet. The owner can enable them with ADMIN_IDS (send /myid to get your ID).",
  adminSelf: "🛡️ Admins can't be banned (that includes you).",
};

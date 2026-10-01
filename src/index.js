import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Telegraf, Markup } from 'telegraf';
import { CFG, mb } from './config.js';
import { normalizeUrl, urlKey } from './url.js';
import { downloadSite } from './downloader.js';
import { JobQueue } from './queue.js';
import { UserError, explainNetError } from './errors.js';
import { assertPublicHost } from './net.js';
import { warmBrowser, closeBrowser, screenshotPage, browserSem } from './browser.js';
import { makeUpdater } from './updater.js';
import * as db from './db.js';
import { initStore, closeStore, cache, limits, previews, kvMode } from './store.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (!CFG.token) {
  console.error('BOT_TOKEN is not set.');
  process.exit(1);
}

const bot = new Telegraf(CFG.token, { handlerTimeout: 10 * 60 * 1000 });
const queue = new JobQueue(CFG.queueConcurrency, CFG.queueMaxWaiting);
const inflight = new Map(); // flight key -> Promise: identical requests share one build

const HELP = [
  '👋 Website Downloader',
  '',
  "Send me a website link and I'll send back a ZIP of its frontend (HTML, CSS, JS, images, fonts). Unzip it and open index.html.",
  '',
  'Any of these work:',
  'example.com',
  'www.example.com/path',
  'https://sub.example.co.ke',
  '',
  'Commands:',
  '/preview <url> - screenshot of the live site',
  '/browser <url> - force browser mode (for JS-heavy sites that came out empty)',
  '/history - your recent downloads',
].join('\n');

const isAdmin = (ctx) => CFG.adminIds.includes(ctx.from?.id);
const argOf = (ctx) => ctx.message.text.split(/\s+/)[1];
const fmtAgo = (ms) => {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};
const sec = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)}s`);

const keyboard = (key, { refresh }) =>
  Markup.inlineKeyboard([[
    Markup.button.callback('🖼 Preview', `p:${key}`),
    ...(refresh ? [Markup.button.callback('🔄 Fresh copy', `r:${key}`)] : []),
  ]]);

async function authorize(ctx) {
  if (CFG.allowedUsers.length && !CFG.allowedUsers.includes(ctx.from.id)) {
    await ctx.reply("Sorry, you're not authorized to use this bot.");
    return false;
  }
  if (await db.isBanned(ctx.from.id)) {
    await ctx.reply('🚫 You have been blocked from using this bot.');
    return false;
  }
  return true;
}

// ---------- commands ----------
bot.start((ctx) => ctx.reply(HELP));
bot.help((ctx) => ctx.reply(HELP));

bot.command('download', (ctx) => {
  const arg = argOf(ctx);
  if (!arg) return ctx.reply('Usage: /download example.com');
  handleRequest(ctx, arg).catch(console.error);
});

bot.command('browser', (ctx) => {
  const arg = argOf(ctx);
  if (!arg) return ctx.reply('Usage: /browser example.com\nForces the headless-browser mode. Use it when a JavaScript-heavy site came out empty.');
  if (!CFG.enableBrowser) return ctx.reply('🧭 Browser mode is disabled on this bot.');
  handleRequest(ctx, arg, { force: true, forceBrowser: true }).catch(console.error);
});

bot.command('preview', async (ctx) => {
  const arg = argOf(ctx);
  if (!arg) return ctx.reply('Usage: /preview example.com');
  if (await authorize(ctx)) sendPreview(ctx, arg).catch(console.error);
});

bot.command('history', async (ctx) => {
  if (!db.enabled()) return ctx.reply('History is not enabled on this bot.');
  if (!(await authorize(ctx))) return;
  const rows = await db.history(ctx.from.id, 8);
  if (!rows.length) return ctx.reply('No downloads yet. Send me a link!');
  await ctx.reply(
    '🕘 Your recent downloads (tap to resend instantly):',
    Markup.inlineKeyboard(rows.map((r) => [Markup.button.callback(
      `${(r.title || r.host).slice(0, 30)} • ${fmtAgo(Date.now() - new Date(r.created_at).getTime())}`, `h:${r.id}`)]))
  );
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const s = db.enabled() ? await db.stats() : null;
  const pct = (a, b) => (Number(b) ? `${Math.round((Number(a) / Number(b)) * 100)}%` : '–');
  const lines = [
    `📊 Website Downloader v${pkg.version}`,
    `Redis: ${kvMode} • Postgres: ${db.enabled() ? 'on' : 'off'}`,
    `Queue: ${queue.active} active, ${queue.waiting.length} waiting`,
  ];
  if (s) {
    lines.push(
      `Users: ${s.users} • Downloads: ${s.total} (24h: ${s.last24h})`,
      `Success: ${pct(s.ok, s.total)} • Cache hits: ${pct(s.cached, s.total)}`,
      `Avg build time: ${(s.avg_ms / 1000).toFixed(1)}s`
    );
    const p = s.phases;
    if (p && Number(p.jobs) > 0)
      lines.push('', `⏱ Avg phases, 7d (${p.jobs} builds, ${pct(p.browser_jobs, p.jobs)} browser):`,
        `fetch ${sec(p.fetch)} • browser ${sec(p.browser)} • assets ${sec(p.assets)} • zip ${sec(p.zip)} • upload ${sec(p.upload)}`);
    lines.push('', 'Top sites (7d):', ...s.hosts.map((h) => `• ${h.host} (${h.c})`),
      '', 'Top failures (7d):', ...s.errors.map((e) => `• ${e.code} (${e.c})`));
  }
  await ctx.reply(lines.join('\n'));
});

for (const [cmd, flag] of [['ban', true], ['unban', false]]) {
  bot.command(cmd, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const id = Number(argOf(ctx));
    if (!Number.isInteger(id)) return ctx.reply(`Usage: /${cmd} <telegram_id>`);
    const ok = await db.setBanned(id, flag);
    await ctx.reply(ok ? `Done: ${id} ${flag ? 'banned' : 'unbanned'}.` : 'User not found (or Postgres is off).');
  });
}

bot.action(/^h:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!(await authorize(ctx))) return;
  const row = await db.getDownload(ctx.match[1], ctx.from.id);
  if (!row?.tg_file_id) return ctx.reply('That file is no longer available. Send the link again to rebuild it.');
  const ok = await sendStored(ctx, {
    fileId: row.tg_file_id, caption: row.caption || `✅ ${row.host}`,
    at: new Date(row.created_at).getTime(), urlKey: row.url_key,
  }, 'From your history');
  if (!ok) await ctx.reply('⚠️ Telegram no longer has that file. Send the link again to rebuild it.');
});

bot.action(/^r:([a-f0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery('Getting a fresh copy…').catch(() => {});
  const url = await cache.urlFor(ctx.match[1]);
  if (!url) return ctx.reply('Send the link again to refresh it.');
  handleRequest(ctx, url, { force: true }).catch(console.error);
});

bot.action(/^p:([a-f0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery('Taking a preview…').catch(() => {});
  if (!(await authorize(ctx))) return;
  const url = await cache.urlFor(ctx.match[1]);
  if (!url) return ctx.reply('Send the link again, then tap Preview.');
  sendPreview(ctx, url).catch(console.error);
});

bot.on('text', (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/') || ctx.chat.type !== 'private') return;
  handleRequest(ctx, text).catch(console.error);
});

// ---------- previews ----------
const previewCaption = (p) => `🖼 ${p.url.host}\nLive site, top of the page (not the downloaded copy)`;

async function sendPreview(ctx, rawUrl) {
  let parsed;
  try { parsed = normalizeUrl(rawUrl); }
  catch (e) { return ctx.reply(`❌ ${e.message}`); }
  const key = urlKey(parsed.url);

  const cachedId = await previews.get(key);
  if (cachedId) {
    try { await ctx.replyWithPhoto(cachedId, { caption: previewCaption(parsed) }); return; }
    catch { /* stale file_id: take a new one */ }
  }
  if (!CFG.enableBrowser) return ctx.reply('🖼 Preview needs the browser, which is disabled on this bot.');
  if (!(await previews.cooldownOk(ctx.from.id))) return ctx.reply('⏳ One preview at a time. Try again in a few seconds.');

  const status = await ctx.reply('🖼 Taking a preview…');
  const edit = (t) => ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, t).catch(() => {});
  try {
    try { await assertPublicHost(parsed.url.hostname); }
    catch (e) { throw explainNetError(e, parsed.url.host); }
    const buf = await browserSem.run(() => screenshotPage(parsed.url.href));
    const sent = await ctx.replyWithPhoto({ source: buf }, { caption: previewCaption(parsed) });
    previews.set(key, sent.photo[sent.photo.length - 1].file_id);
    ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
  } catch (e) {
    if (e instanceof UserError) return edit(e.message);
    console.error('preview failed:', e?.message);
    return edit(/ERR_NAME_NOT_RESOLVED/.test(String(e?.message))
      ? `❓ I couldn't find ${parsed.url.host}. Check the address.`
      : "❌ I couldn't load a preview of that page.");
  }
}

// ---------- core flow ----------
async function sendStored(ctx, data, label) {
  try {
    ctx.sendChatAction('upload_document').catch(() => {});
    const extra = { caption: `${data.caption}\n⚡ ${label} (${fmtAgo(Date.now() - data.at)})`.slice(0, 1000) };
    if (data.urlKey) Object.assign(extra, keyboard(data.urlKey, { refresh: true }));
    await ctx.replyWithDocument(data.fileId, extra);
    return true;
  } catch (e) {
    if (/file|bad request/i.test(String(e?.message))) await db.invalidateFile(data.fileId);
    return false;
  }
}

async function handleRequest(ctx, raw, { force = false, forceBrowser = false } = {}) {
  const uid = ctx.from.id;
  if (CFG.allowedUsers.length && !CFG.allowedUsers.includes(uid))
    return ctx.reply("Sorry, you're not authorized to use this bot.");

  let parsed;
  try { parsed = normalizeUrl(raw); }
  catch (e) { return ctx.reply(`❌ ${e.message}`); }
  const key = urlKey(parsed.url);
  const base = { userId: uid, url: parsed.url.href, urlKey: key, host: parsed.url.host };

  // user check + both caches in parallel: one round-trip of latency, not three
  const [user, hit, neg] = await Promise.all([
    db.touchUser(ctx.from),
    force ? null : cache.getResult(key),
    force ? null : cache.getNegative(key),
  ]);
  if (user?.banned) return ctx.reply('🚫 You have been blocked from using this bot.');

  if (hit) {
    if (await sendStored(ctx, hit, 'Instant copy')) {
      db.record({ ...base, status: 'ok', mode: hit.mode, cached: true, files: hit.files, zipBytes: hit.zipBytes, durationMs: 0, fileId: hit.fileId, fileName: hit.fileName, caption: hit.caption, title: hit.title });
      return;
    }
    await cache.dropResult(key); // stale file_id: rebuild below
  }
  if (neg) return ctx.reply(`${neg.message}\n\n(I checked this a moment ago. Try again in a few minutes.)`);

  let held = false;
  let ran = false;
  try {
    if (!(await limits.tryAcquire(uid))) return ctx.reply('⏳ You already have a download running. Please wait for it to finish.');
    held = true;
    const wait = await limits.cooldownLeft(uid);
    if (wait > 0) return ctx.reply(`⏳ Please wait ${Math.ceil(wait / 1000)}s before your next request.`);
    ran = true;
    await build(ctx, parsed, key, base, { forceBrowser });
  } finally {
    if (held) await limits.release(uid, ran);
  }
}

async function build(ctx, parsed, key, base, opts) {
  const started = Date.now();
  const flightKey = opts.forceBrowser ? `${key}:b` : key;
  let p = inflight.get(flightKey);
  const leader = !p;
  const ahead = queue.load;
  const status = await ctx.reply(
    !leader ? '🔁 Someone just requested this site. Getting it for you…'
      : ahead >= CFG.queueConcurrency ? `📥 Queued (${ahead} ahead of you)…`
      : `📥 Starting ${parsed.url.host}…`
  );
  const update = makeUpdater(ctx, status);

  try {
    if (leader) {
      p = queue.add(() => produce(ctx, parsed, key, update, opts)); // throws QUEUE_FULL synchronously
      inflight.set(flightKey, p);
      p.finally(() => inflight.delete(flightKey)).catch(() => {});
    }
    const data = await p;
    if (!leader && !(await sendStored(ctx, data, 'Shared download')))
      throw new UserError('⚠️ Something went wrong sending the file. Please try again.', 'send_failed');

    await update.flush();
    ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    db.record({
      ...base, status: 'ok', mode: data.mode, cached: !leader, files: data.files, zipBytes: data.zipBytes,
      durationMs: Date.now() - started, fileId: data.fileId, fileName: data.fileName, caption: data.caption,
      title: data.title, timings: leader ? data.timings : null,
    });
  } catch (e) {
    let code = 'internal';
    if (e instanceof UserError) {
      code = e.code;
      update(e.message);
      if (leader) cache.setNegative(key, { message: e.message, code });
    } else if (e?.message === 'QUEUE_FULL') {
      code = 'queue_full';
      update("🚦 I'm busy right now. Please try again in a minute.");
    } else {
      console.error('job failed:', e);
      update('❌ Something went wrong while downloading that site. Please try again or try another link.');
    }
    await update.flush();
    db.record({ ...base, status: 'failed', errorCode: code, durationMs: Date.now() - started });
  }
}

function buildCaption(r) {
  const lines = [`✅ ${r.host}`];
  if (r.title) lines.push(`📝 ${r.title}`);
  lines.push(`📁 ${r.fileCount} files • ${mb(r.zipBytes)} MB • ${r.mode === 'browser' ? 'browser mode' : 'fast mode'}`);
  if (r.skipped + r.failed > 0) lines.push(`⚠️ ${r.skipped} skipped, ${r.failed} failed (see skipped.txt)`);
  lines.push(...r.warnings);
  lines.push(`Unzip and open index.html${r.mode === 'browser' ? ' (see README.txt)' : ''}`);
  return lines.join('\n').slice(0, 900);
}

// build + upload once; the Telegram file_id is what every later request reuses
async function produce(ctx, parsed, key, update, opts) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-'));
  try {
    const r = await downloadSite(parsed, workDir, update, opts);
    update('📤 Uploading…');
    ctx.sendChatAction('upload_document').catch(() => {});
    const caption = buildCaption(r);
    const tu = Date.now();
    const msg = await ctx.replyWithDocument(
      { source: r.zipPath, filename: r.zipName },
      { caption, ...keyboard(key, { refresh: false }) }
    );
    r.timings.upload = Date.now() - tu;
    const data = {
      urlKey: key, fileId: msg.document.file_id, fileName: r.zipName, caption, title: r.title,
      host: r.host, mode: r.mode, files: r.fileCount, zipBytes: r.zipBytes, at: Date.now(), timings: r.timings,
    };
    await Promise.all([cache.setResult(key, data), cache.rememberUrl(key, parsed.url.href)]);
    return data;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- lifecycle ----------
bot.catch((err) => console.error('bot error:', err));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

async function main() {
  console.log(`Website Downloader v${pkg.version} starting…`);
  await initStore();
  await db.init();
  db.startRetention();
  if (CFG.enableBrowser) warmBrowser().then(() => console.log('Chromium warmed up')).catch((e) => console.error('Chromium warm-up failed:', e.message));

  bot.telegram.setMyCommands([
    { command: 'start', description: 'How to use the bot' },
    { command: 'preview', description: 'Screenshot of a live site: /preview example.com' },
    { command: 'browser', description: 'Force browser mode: /browser example.com' },
    { command: 'history', description: 'Your recent downloads' },
    { command: 'download', description: 'Download a site: /download example.com' },
  ]).catch(() => {});

  bot.launch({ dropPendingUpdates: true }).catch((e) => { console.error(e); process.exit(1); });
  console.log('Website Downloader (@WebsiteDownloaderBot) is running.');
}

let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 8000).unref();
  try { bot.stop(sig); } catch { /* not started */ }
  await Promise.allSettled([closeBrowser(), closeStore(), db.shutdown()]);
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch((e) => { console.error('Fatal startup error:', e); process.exit(1); });

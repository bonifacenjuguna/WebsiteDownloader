import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Telegraf, Markup } from 'telegraf';
import { CFG, mb } from './config.js';
import { normalizeUrl, urlKey, sectionKey } from './url.js';
import { downloadSite } from './downloader.js';
import { downloadSection } from './site.js';
import { JobQueue } from './queue.js';
import { UserError, explainNetError } from './errors.js';
import { assertPublicHost } from './net.js';
import { warmBrowser, closeBrowser, screenshotPage, browserSem } from './browser.js';
import { makeUpdater } from './updater.js';
import { syncProfile } from './profile.js';
import * as db from './db.js';
import { initStore, closeStore, cache, limits, previews, quota, kvMode } from './store.js';

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
  '/site <url> - save a whole section (e.g. example.com/docs) or every file of an open folder listing',
  '/history - your recent downloads',
].join('\n');

const isAdmin = (ctx) => CFG.adminIds.includes(ctx.from?.id);
const denyAdmin = (ctx) => ctx.reply(CFG.adminIds.length
  ? '🔒 Admins only.'
  : '🔒 Admin commands are off. Set ADMIN_IDS on the server to your Telegram ID (send /myid to see it) and redeploy.');
const argOf = (ctx) => ctx.message.text.split(/\s+/)[1];
const fmtAgo = (ms) => {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};
const sec = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)}s`);

const keyboard = (key, { refresh, thin, section }) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('🖼 Preview', `p:${key}`),
      ...(refresh ? [Markup.button.callback('🔄 Fresh copy', `${section ? 'rs' : 'r'}:${key}`)] : []),
    ],
    ...(thin ? [[Markup.button.callback('🧭 Retry in browser mode', `b:${key}`)]] : []),
  ]);

async function authorize(ctx) {
  if (isAdmin(ctx)) return true; // admins can never be locked out
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

bot.command('myid', (ctx) => ctx.reply(`Your Telegram ID: ${ctx.from.id}${isAdmin(ctx) ? '\n✅ You are an admin.' : ''}`));

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

bot.command('site', (ctx) => {
  const arg = argOf(ctx);
  if (!arg) return ctx.reply(`Usage: /site example.com/docs\n\nSaves a whole section (up to ${CFG.siteMaxPages} pages, ${CFG.siteDepth} levels deep) with working links between pages, or every file of an open folder listing ("Index of /files/").`);
  handleRequest(ctx, arg, { section: true }).catch(console.error);
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
  if (!isAdmin(ctx)) return denyAdmin(ctx);
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
    if (!isAdmin(ctx)) return denyAdmin(ctx);
    const id = Number(argOf(ctx));
    if (!Number.isInteger(id)) return ctx.reply(`Usage: /${cmd} <telegram_id>`);
    if (flag && CFG.adminIds.includes(id)) return ctx.reply("🛡️ Admins can't be banned (that includes you).");
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
    fileId: row.tg_file_id, caption: row.caption || `✅ ${row.host}`, section: (row.mode || '').startsWith('site-'),
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

bot.action(/^rs:([a-f0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery('Getting a fresh copy…').catch(() => {});
  const url = await cache.urlFor(ctx.match[1]);
  if (!url) return ctx.reply('Send /site <url> again to refresh it.');
  handleRequest(ctx, url, { force: true, section: true }).catch(console.error);
});

bot.action(/^p:([a-f0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery('Taking a preview…').catch(() => {});
  if (!(await authorize(ctx))) return;
  const url = await cache.urlFor(ctx.match[1]);
  if (!url) return ctx.reply('Send the link again, then tap Preview.');
  sendPreview(ctx, url).catch(console.error);
});

bot.action(/^b:([a-f0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery('Retrying in browser mode…').catch(() => {});
  if (!CFG.enableBrowser) return ctx.reply('🧭 Browser mode is disabled on this bot.');
  const url = await cache.urlFor(ctx.match[1]);
  if (!url) return ctx.reply('Send the link again, then use /browser <url>.');
  handleRequest(ctx, url, { force: true, forceBrowser: true }).catch(console.error);
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
  if (!isAdmin(ctx) && !(await previews.cooldownOk(ctx.from.id))) return ctx.reply('⏳ One preview at a time. Try again in a few seconds.');

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
    const ids = String(data.fileId).split(',').filter(Boolean);
    for (let i = 0; i < ids.length; i++) {
      const extra = {
        caption: i === 0
          ? `${data.caption}\n⚡ ${label} (${fmtAgo(Date.now() - data.at)})`.slice(0, 1000)
          : `📦 Part ${i + 1}/${ids.length}`,
      };
      if (i === ids.length - 1 && data.urlKey)
        Object.assign(extra, keyboard(data.urlKey, { refresh: true, thin: data.thin, section: data.section }));
      await ctx.replyWithDocument(ids[i], extra);
    }
    return true;
  } catch (e) {
    if (/file|bad request/i.test(String(e?.message))) await db.invalidateFile(data.fileId);
    return false;
  }
}

async function handleRequest(ctx, raw, { force = false, forceBrowser = false, section = false } = {}) {
  const uid = ctx.from.id;
  const admin = isAdmin(ctx);
  if (!admin && CFG.allowedUsers.length && !CFG.allowedUsers.includes(uid))
    return ctx.reply("Sorry, you're not authorized to use this bot.");

  let parsed;
  try { parsed = normalizeUrl(raw); }
  catch (e) { return ctx.reply(`❌ ${e.message}`); }
  const key = section ? sectionKey(urlKey(parsed.url)) : urlKey(parsed.url);
  const base = { userId: uid, url: parsed.url.href, urlKey: key, host: parsed.url.host };

  // user check + both caches in parallel: one round-trip of latency, not three
  const [user, hit, neg] = await Promise.all([
    db.touchUser(ctx.from),
    force ? null : cache.getResult(key),
    force ? null : cache.getNegative(key),
  ]);
  if (user?.banned && !admin) return ctx.reply('🚫 You have been blocked from using this bot.');

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
    if (!admin) {
      if (!(await limits.tryAcquire(uid))) return ctx.reply('⏳ You already have a download running. Please wait for it to finish.');
      held = true;
      const wait = await limits.cooldownLeft(uid);
      if (wait > 0) return ctx.reply(`⏳ Please wait ${Math.ceil(wait / 1000)}s before your next request.`);
      if (CFG.dailyLimit) {
        const used = await quota.consume(uid);
        if (used > CFG.dailyLimit)
          return ctx.reply(`📅 You've used today's ${CFG.dailyLimit} new downloads. Sites I already have cached and previews still work. The limit resets at 00:00 UTC.`);
      }
    }
    ran = true;
    await build(ctx, parsed, key, base, { forceBrowser, section });
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

function buildCaption(r, nParts = 1) {
  const lines = [`✅ ${r.host}`];
  if (r.kind === 'listing') {
    lines.push(`📂 ${r.title} • ${r.dirCount} folder${r.dirCount === 1 ? '' : 's'} • ${r.fileCount} files • ${mb(r.zipBytes)} MB`);
    if (nParts > 1) lines.push(`📦 Sent as ${nParts} ZIP parts. Unzip them all into one folder.`);
  } else if (r.kind === 'pages') {
    lines.push(`📄 ${r.pages} page${r.pages === 1 ? '' : 's'} • ${r.fileCount} files • ${mb(r.zipBytes)} MB`);
    if (r.title) lines.push(`📝 ${r.title}`);
  } else {
    if (r.title) lines.push(`📝 ${r.title}`);
    lines.push(`📁 ${r.fileCount} files • ${mb(r.zipBytes)} MB • ${r.mode === 'browser' ? 'browser mode' : 'fast mode'}`);
  }
  if (r.skipped + r.failed > 0) lines.push(`⚠️ ${r.skipped} skipped, ${r.failed} failed (see skipped.txt)`);
  lines.push(...r.warnings);
  if (r.thin) lines.push('🤔 This page looks mostly empty. It may load its content with JavaScript, so try browser mode.');
  lines.push(r.kind === 'listing' ? 'Open index.html for a clickable file list' : `Unzip and open index.html${r.mode === 'browser' ? ' (see README.txt)' : ''}`);
  return lines.join('\n').slice(0, 900);
}

// build + upload once; the Telegram file_id is what every later request reuses
async function produce(ctx, parsed, key, update, opts) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-'));
  try {
    const r = opts.section
      ? await downloadSection(parsed, workDir, update)
      : await downloadSite(parsed, workDir, update, opts);
    const parts = r.parts ?? [{ zipPath: r.zipPath, zipName: r.zipName }];
    const caption = buildCaption(r, parts.length);
    const tu = Date.now();
    const ids = [];
    for (let i = 0; i < parts.length; i++) {
      update(parts.length > 1 ? `📤 Uploading part ${i + 1}/${parts.length}…` : '📤 Uploading…');
      ctx.sendChatAction('upload_document').catch(() => {});
      const last = i === parts.length - 1;
      const msg = await ctx.replyWithDocument(
        { source: parts[i].zipPath, filename: parts[i].zipName },
        {
          caption: i === 0 ? caption : `📦 Part ${i + 1}/${parts.length} • ${r.host}`,
          ...(last ? keyboard(key, { refresh: false, thin: r.thin, section: !!opts.section }) : {}),
        }
      );
      ids.push(msg.document.file_id);
    }
    r.timings.upload = Date.now() - tu;
    const data = {
      urlKey: key, fileId: ids.join(','), fileName: parts[0].zipName, caption, title: r.title, thin: r.thin,
      section: !!opts.section, host: r.host, mode: r.mode, files: r.fileCount, zipBytes: r.zipBytes,
      at: Date.now(), timings: r.timings,
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

  const commands = [
    { command: 'start', description: 'How to use the bot' },
    { command: 'preview', description: 'Screenshot of a live site: /preview example.com' },
    { command: 'browser', description: 'Force browser mode: /browser example.com' },
    { command: 'site', description: 'Save a section or folder: /site example.com/docs' },
    { command: 'history', description: 'Your recent downloads' },
    { command: 'download', description: 'Download a site: /download example.com' },
    { command: 'myid', description: 'Show your Telegram ID' },
  ];
  bot.telegram.setMyCommands(commands).catch(() => {});
  if (CFG.adminIds.length) {
    const adminCommands = [
      ...commands,
      { command: 'stats', description: 'Admin: usage, speed and errors' },
      { command: 'ban', description: 'Admin: /ban <telegram_id>' },
      { command: 'unban', description: 'Admin: /unban <telegram_id>' },
    ];
    for (const id of CFG.adminIds) {
      // admins see the extra commands in their own menu (works once they have messaged the bot)
      bot.telegram.setMyCommands(adminCommands, { scope: { type: 'chat', chat_id: id } }).catch(() => {});
    }
    console.log(`Admins: ${CFG.adminIds.join(', ')}`);
  } else {
    console.log('ADMIN_IDS not set: /stats, /ban, /unban are disabled. Message the bot /myid to get your ID.');
  }

  syncProfile(bot.telegram).catch((e) => console.error('Profile sync failed:', e?.message));

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

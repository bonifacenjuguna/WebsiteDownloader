import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Telegraf, Markup } from 'telegraf';
import { CFG, mb } from './config.js';
import { normalizeUrl, urlKey, sectionKey } from './url.js';
import { downloadWebsite } from './site.js';
import { JobQueue } from './queue.js';
import { UserError, explainNetError } from './errors.js';
import { assertPublicHost } from './net.js';
import { warmBrowser, closeBrowser, screenshotPage, browserSem } from './browser.js';
import { makeUpdater } from './updater.js';
import { syncProfile } from './profile.js';
import { renderMenu, renderPage } from './help.js';
import { START_TEXT, STATUS, MSG, errorText, codeOf, actionsFor, failureActions, RETRY_CODES, buildCaption, previewCaption } from './copy.js';
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

const isAdmin = (ctx) => CFG.adminIds.includes(ctx.from?.id);
const denyAdmin = (ctx) => ctx.reply(CFG.adminIds.length ? MSG.adminOnly : MSG.adminOff);
const argOf = (ctx) => ctx.message.text.split(/\s+/)[1];
const fmtAgo = (ms) => {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};
const sec = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)}s`);

const chunk2 = (arr) => { const out = []; for (let i = 0; i < arr.length; i += 2) out.push(arr.slice(i, i + 2)); return out; };
const buttons = (key, actions) => Markup.inlineKeyboard(chunk2(actions.map((a) => Markup.button.callback(a.text, `${a.cb}:${key}`))));
const keyboard = (key, opts) => buttons(key, actionsFor(opts));
// the one most useful alternative after a failure (Try again / Browser mode), or nothing
const failureMarkup = (code, key) => {
  const actions = failureActions(code);
  return actions.length ? buttons(key, actions) : undefined;
};

// help.js returns plain {text, data} rows; turn them into Telegram buttons
const toMarkup = (rows) => Markup.inlineKeyboard(rows.map((r) => r.map((b) => Markup.button.callback(b.text, b.data))));
const helpExtra = (view) => ({ parse_mode: 'HTML', ...toMarkup(view.rows) });

async function authorize(ctx) {
  if (isAdmin(ctx)) return true; // admins can never be locked out
  if (CFG.allowedUsers.length && !CFG.allowedUsers.includes(ctx.from.id)) {
    await ctx.reply(MSG.notAuthorized);
    return false;
  }
  if (await db.isBanned(ctx.from.id)) {
    await ctx.reply(MSG.banned);
    return false;
  }
  return true;
}

// ---------- commands ----------
bot.start((ctx) => ctx.reply(START_TEXT, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('📖 Help', 'hp:m')]]) }));
bot.help((ctx) => {
  const view = renderMenu(isAdmin(ctx));
  return ctx.reply(view.text, helpExtra(view));
});

bot.command('myid', (ctx) => ctx.reply(`Your Telegram ID: ${ctx.from.id}${isAdmin(ctx) ? '\n✅ You are an admin.' : ''}`));

bot.command('download', (ctx) => {
  const arg = argOf(ctx);
  if (!arg) return ctx.reply(MSG.usageDownload);
  handleRequest(ctx, arg).catch(console.error);
});

bot.command('browser', (ctx) => {
  const arg = argOf(ctx);
  if (!arg) return ctx.reply(MSG.usageBrowser);
  if (!CFG.enableBrowser) return ctx.reply(MSG.browserOff);
  handleRequest(ctx, arg, { force: true, forceBrowser: true }).catch(console.error);
});

// retired: every link is now saved as a whole site. Kept as a hidden alias so old habits and old buttons keep working.
bot.command('site', (ctx) => {
  const arg = argOf(ctx);
  if (!arg) return ctx.reply(MSG.usageDownload);
  handleRequest(ctx, arg).catch(console.error);
});

bot.command('preview', async (ctx) => {
  const arg = argOf(ctx);
  if (!arg) return ctx.reply(MSG.usagePreview);
  if (await authorize(ctx)) sendPreview(ctx, arg).catch(console.error);
});

bot.command('history', async (ctx) => {
  if (!db.enabled()) return ctx.reply(MSG.historyOff);
  if (!(await authorize(ctx))) return;
  const rows = await db.history(ctx.from.id, 8);
  if (!rows.length) return ctx.reply(MSG.historyEmpty);
  await ctx.reply(
    MSG.historyTitle,
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
    if (flag && CFG.adminIds.includes(id)) return ctx.reply(MSG.adminSelf);
    const ok = await db.setBanned(id, flag);
    await ctx.reply(ok ? `Done: ${id} ${flag ? 'banned' : 'unbanned'}.` : 'User not found (or Postgres is off).');
  });
}

// /help: topic buttons swap the message in place; ◀ ▶ page through; 🏠 menu; ✖ close
bot.action(/^hp:(m|n|x|\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const arg = ctx.match[1];
  if (arg === 'n') return;
  if (arg === 'x') return ctx.deleteMessage().catch(() => {});
  const admin = isAdmin(ctx);
  const view = arg === 'm' ? renderMenu(admin) : renderPage(Number(arg), admin);
  await ctx.editMessageText(view.text, helpExtra(view)).catch(() => {}); // "not modified" when the same page is tapped again
});

bot.action(/^h:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!(await authorize(ctx))) return;
  const row = await db.getDownload(ctx.match[1], ctx.from.id);
  if (!row?.tg_file_id) return ctx.reply(MSG.fileGone);
  const ok = await sendStored(ctx, {
    fileId: row.tg_file_id, caption: row.caption || `✅ ${row.host}`,
    at: new Date(row.created_at).getTime(), urlKey: row.url_key,
  }, 'history');
  if (!ok) await ctx.reply(MSG.fileGone);
});

bot.action(/^rs?:([a-f0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery('Getting a fresh copy…').catch(() => {});
  const url = await cache.urlFor(ctx.match[1]);
  if (!url) return ctx.reply(MSG.refreshLost);
  handleRequest(ctx, url, { force: true }).catch(console.error);
});

bot.action(/^p:([a-f0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery('Capturing a preview…').catch(() => {});
  if (!(await authorize(ctx))) return;
  const url = await cache.urlFor(ctx.match[1]);
  if (!url) return ctx.reply(MSG.previewLost);
  sendPreview(ctx, url).catch(console.error);
});

bot.action(/^b:([a-f0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery('Opening in browser mode…').catch(() => {});
  if (!CFG.enableBrowser) return ctx.reply(MSG.browserOff);
  const url = await cache.urlFor(ctx.match[1]);
  if (!url) return ctx.reply(MSG.browserLost);
  handleRequest(ctx, url, { force: true, forceBrowser: true }).catch(console.error);
});

bot.on('text', (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/') || ctx.chat.type !== 'private') return;
  handleRequest(ctx, text).catch(console.error);
});

// ---------- previews ----------
const previewCaptionOf = (p) => previewCaption(p.url.host);

async function sendPreview(ctx, rawUrl) {
  let parsed;
  try { parsed = normalizeUrl(rawUrl); }
  catch (e) { return ctx.reply(errorText(codeOf(e))); }
  const key = urlKey(parsed.url);

  const cachedId = await previews.get(key);
  if (cachedId) {
    try { await ctx.replyWithPhoto(cachedId, { caption: previewCaptionOf(parsed) }); return; }
    catch { /* stale file_id: take a new one */ }
  }
  if (!CFG.enableBrowser) return ctx.reply(MSG.previewOff);
  if (!isAdmin(ctx) && !(await previews.cooldownOk(ctx.from.id))) return ctx.reply(MSG.previewWait);

  const status = await ctx.reply(STATUS.preview);
  const edit = (t) => ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, t).catch(() => {});
  try {
    try { await assertPublicHost(parsed.url.hostname); }
    catch (e) { throw explainNetError(e, parsed.url.host); }
    const buf = await browserSem.run(() => screenshotPage(parsed.url.href));
    const sent = await ctx.replyWithPhoto({ source: buf }, { caption: previewCaptionOf(parsed) });
    previews.set(key, sent.photo[sent.photo.length - 1].file_id);
    ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
  } catch (e) {
    if (e instanceof UserError) return edit(errorText(e.code));
    console.error('preview failed:', e?.message);
    return edit(/ERR_NAME_NOT_RESOLVED/.test(String(e?.message)) ? errorText('dns') : MSG.previewFail);
  }
}

// ---------- core flow ----------
async function sendStored(ctx, data, label) {
  try {
    ctx.sendChatAction('upload_document').catch(() => {});
    const ids = String(data.fileId).split(',').filter(Boolean);
    // a result someone else just built looks like a normal fresh result: no "from cache" footer
    const footer = label === 'shared' ? '' : `\n⚡ ${label === 'history' ? 'From your history' : 'Instant copy'} · saved ${fmtAgo(Date.now() - data.at)}`;
    for (let i = 0; i < ids.length; i++) {
      const extra = { caption: i === 0 ? `${data.caption}${footer}`.slice(0, 1000) : `📦 Part ${i + 1}/${ids.length}` };
      if (i === ids.length - 1 && data.urlKey)
        Object.assign(extra, keyboard(data.urlKey, { refresh: label !== 'shared', thin: data.thin }));
      await ctx.replyWithDocument(ids[i], extra);
    }
    return true;
  } catch (e) {
    if (/file|bad request/i.test(String(e?.message))) await db.invalidateFile(data.fileId);
    return false;
  }
}

async function handleRequest(ctx, raw, { force = false, forceBrowser = false } = {}) {
  const uid = ctx.from.id;
  const admin = isAdmin(ctx);
  if (!admin && CFG.allowedUsers.length && !CFG.allowedUsers.includes(uid))
    return ctx.reply(MSG.notAuthorized);

  let parsed;
  try { parsed = normalizeUrl(raw); }
  catch (e) { return ctx.reply(errorText(codeOf(e))); }
  // one key family for whole-site results (the old single-page cache entries are intentionally not reused)
  const key = sectionKey(urlKey(parsed.url));
  const base = { userId: uid, url: parsed.url.href, urlKey: key, host: parsed.url.host };

  // user check + both caches in parallel: one round-trip of latency, not three
  const [user, hit, neg] = await Promise.all([
    db.touchUser(ctx.from),
    force ? null : cache.getResult(key),
    force ? null : cache.getNegative(key),
  ]);
  if (user?.banned && !admin) return ctx.reply(MSG.banned);

  if (hit) {
    if (await sendStored(ctx, hit, 'cache')) {
      db.record({ ...base, status: 'ok', mode: hit.mode, cached: true, files: hit.files, zipBytes: hit.zipBytes, durationMs: 0, fileId: hit.fileId, fileName: hit.fileName, caption: hit.caption, title: hit.title });
      return;
    }
    await cache.dropResult(key); // stale file_id: rebuild below
  }
  if (neg) {
    cache.rememberUrl(key, parsed.url.href);
    const retry = RETRY_CODES.has(neg.code);
    return ctx.reply(retry ? `${neg.message}\n\n${MSG.retrySoon}` : neg.message, failureMarkup(neg.code, key));
  }

  let held = false;
  let ran = false;
  try {
    if (!admin) {
      if (!(await limits.tryAcquire(uid))) return ctx.reply(MSG.busy);
      held = true;
      const wait = await limits.cooldownLeft(uid);
      if (wait > 0) return ctx.reply(MSG.cooldown(Math.ceil(wait / 1000)));
      if (CFG.dailyLimit) {
        const used = await quota.consume(uid);
        if (used > CFG.dailyLimit)
          return ctx.reply(MSG.daily(CFG.dailyLimit));
      }
    }
    ran = (await build(ctx, parsed, key, base, { forceBrowser })) !== false;
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
    !leader ? STATUS.shared
      : ahead >= CFG.queueConcurrency ? STATUS.queued(ahead)
      : STATUS.starting(parsed.url.host)
  );
  const update = makeUpdater(ctx, status);

  try {
    if (leader) {
      p = queue.add(() => produce(ctx, parsed, key, update, opts)); // throws QUEUE_FULL synchronously
      inflight.set(flightKey, p);
      p.finally(() => inflight.delete(flightKey)).catch(() => {});
    }
    const data = await p;
    if (!leader && !(await sendStored(ctx, data, 'shared')))
      throw new UserError('could not resend shared result', 'send_failed');

    await update.flush();
    ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    db.record({
      ...base, status: 'ok', mode: data.mode, cached: !leader, files: data.files, zipBytes: data.zipBytes,
      durationMs: Date.now() - started, fileId: data.fileId, fileName: data.fileName, caption: data.caption,
      title: data.title, timings: leader ? data.timings : null,
    });
    return true;
  } catch (e) {
    // precise detail stays in the logs and database; the user gets a short human message
    const code = codeOf(e);
    const text = errorText(code);
    if (code === 'internal') console.error('job failed:', e);
    else console.warn(`[job] ${code} ${parsed.url.host}: ${e?.message}`);
    cache.rememberUrl(key, parsed.url.href); // lets the Try again / Browser mode buttons find the link
    update(text, failureMarkup(code, key));
    if (leader && e instanceof UserError) cache.setNegative(key, { message: text, code });
    await update.flush();
    db.record({ ...base, status: 'failed', errorCode: code, durationMs: Date.now() - started });
    return false;
  }
}

// build + upload once; the Telegram file_id is what every later request reuses
async function produce(ctx, parsed, key, update, opts) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-'));
  try {
    const r = await downloadWebsite(parsed, workDir, update, opts);
    const parts = r.parts ?? [{ zipPath: r.zipPath, zipName: r.zipName }];
    const caption = buildCaption(r, parts.length);
    const tu = Date.now();
    const ids = [];
    for (let i = 0; i < parts.length; i++) {
      update(STATUS.sending(i + 1, parts.length));
      ctx.sendChatAction('upload_document').catch(() => {});
      const last = i === parts.length - 1;
      const msg = await ctx.replyWithDocument(
        { source: parts[i].zipPath, filename: parts[i].zipName },
        {
          caption: i === 0 ? caption : `📦 Part ${i + 1}/${parts.length} • ${r.host}`,
          ...(last ? keyboard(key, { refresh: false, thin: r.thin }) : {}),
        }
      );
      ids.push(msg.document.file_id);
    }
    r.timings.upload = Date.now() - tu;
    const data = {
      urlKey: key, fileId: ids.join(','), fileName: parts[0].zipName, caption, title: r.title, thin: r.thin,
      host: r.host, mode: r.mode, files: r.fileCount, zipBytes: r.zipBytes,
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
    { command: 'start', description: 'Welcome and quick start' },
    { command: 'help', description: 'What I can do, with guides' },
    { command: 'preview', description: 'Preview a live page: /preview example.com' },
    { command: 'browser', description: 'Capture a dynamic site: /browser example.com' },
    { command: 'history', description: 'Your recent downloads' },
    { command: 'download', description: 'Save a website: /download example.com' },
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

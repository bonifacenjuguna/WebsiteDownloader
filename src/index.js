import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Telegraf, Telegram, Markup } from 'telegraf';
import { CFG } from './config.js';
import { normalizeUrl, extractUrls, urlKey, sectionKey, bareHost } from './url.js';
import { downloadWebsite } from './site.js';
import { JobQueue } from './queue.js';
import { UserError, explainNetError } from './errors.js';
import { assertPublicHost } from './net.js';
import { warmBrowser, closeBrowser, screenshotPage, browserSem, browserStats } from './browser.js';
import { makeUpdater } from './updater.js';
import { syncProfile } from './profile.js';
import { renderMenu, renderPage } from './help.js';
import { tr, LANGS, mapLang, buildSummary, codeOf } from './copy.js';
import * as db from './db.js';
import { initStore, closeStore, cache, limits, previews, quota, lang as langStore, kvMode, kv } from './store.js';
import * as policy from './policy.js';
import * as fingerprint from './fingerprint.js';
import * as resume from './resume.js';
import { startHealth } from './health.js';
import { setNotifier, recordJob } from './alerts.js';
import { syncCommands } from './commands.js';
import { memoryShare, memoryMb } from './health-util.js';
import { esc, b, i, code, dot, ms as fmtMs, uptime as fmtUptime, utc, table, stripTags } from './fmt.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (!CFG.token) {
  console.error('BOT_TOKEN is not set.');
  process.exit(1);
}

// Every message the bot sends is HTML (bold titles, monospace values, italic hints). A malformed tag makes Telegram
// reject the WHOLE message, so on exactly that error the text is resent as plain text instead of being lost.
// Patched on the class because Telegraf builds a fresh Telegram client per update.
const HTML_METHODS = new Set(['sendMessage', 'editMessageText', 'sendDocument', 'sendPhoto', 'editMessageCaption']);
const rawCallApi = Telegram.prototype.callApi;
Telegram.prototype.callApi = async function callApi(method, payload = {}, ...rest) {
  if (!HTML_METHODS.has(method)) return rawCallApi.call(this, method, payload, ...rest);
  try {
    return await rawCallApi.call(this, method, payload.parse_mode === undefined ? { ...payload, parse_mode: 'HTML' } : payload, ...rest);
  } catch (e) {
    if (!/can't parse entities/i.test(String(e?.description || e?.message))) throw e;
    const plain = { ...payload };
    delete plain.parse_mode;
    if (typeof plain.text === 'string') plain.text = stripTags(plain.text);
    if (typeof plain.caption === 'string') plain.caption = stripTags(plain.caption);
    console.warn(`[format] ${method}: Telegram could not parse the HTML, sent as plain text`);
    return rawCallApi.call(this, method, plain, ...rest);
  }
};

const bot = new Telegraf(CFG.token, { handlerTimeout: 10 * 60 * 1000 });
const queue = new JobQueue(CFG.queueConcurrency, CFG.queueMaxWaiting);
// flight key -> { promise, controller, members: Map<userId, member> }: identical requests share one build
const flights = new Map();
let stopping = false;
const startedAt = Date.now();

const isAdmin = (ctx) => CFG.adminIds.includes(ctx.from?.id);
const argOf = (ctx) => ctx.message.text.split(/\s+/)[1];
const restOf = (ctx) => ctx.message.text.replace(/^\/\S+\s*/, '');

// ---------- language: the person's /language pick, else their Telegram app language ----------
async function Lof(ctx) {
  const chosen = ctx.from?.id ? await langStore.get(ctx.from.id).catch(() => null) : null;
  return tr(chosen || mapLang(ctx.from?.language_code));
}

const denyAdmin = async (ctx) => { const L = await Lof(ctx); return ctx.reply(CFG.adminIds.length ? L.MSG.adminOnly : L.MSG.adminOff); };

// ---------- buttons ----------
const chunk2 = (arr) => { const out = []; for (let i = 0; i < arr.length; i += 2) out.push(arr.slice(i, i + 2)); return out; };
const buttons = (key, actions) => Markup.inlineKeyboard(chunk2(actions.map((a) => Markup.button.callback(a.text, `${a.cb}:${key}`))));
const keyboard = (L, key, opts) => buttons(key, L.actionsFor(opts));
// the one useful alternative after a failure (Try again), or nothing
const failureMarkup = (L, code, key) => {
  const actions = L.failureActions(code);
  return actions.length ? buttons(key, actions) : null;
};
const NO_KB = { reply_markup: { inline_keyboard: [] } };

// help.js returns plain {text, data} rows; turn them into Telegram buttons
const toMarkup = (rows) => Markup.inlineKeyboard(rows.map((r) => r.map((b) => Markup.button.callback(b.text, b.data))));
const helpExtra = (view) => ({ parse_mode: 'HTML', ...toMarkup(view.rows) });

async function authorize(ctx, L) {
  if (isAdmin(ctx)) return true; // admins can never be locked out
  if (CFG.allowedUsers.length && !CFG.allowedUsers.includes(ctx.from.id)) {
    await ctx.reply(L.MSG.notAuthorized);
    return false;
  }
  if (await db.isBanned(ctx.from.id)) {
    await ctx.reply(L.MSG.banned);
    return false;
  }
  return true;
}

// ---------- commands ----------
bot.start(async (ctx) => {
  const L = await Lof(ctx);
  return ctx.reply(L.START_TEXT, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback(L.BTN.help, 'hp:m')]]) });
});
bot.help((ctx) => {
  const view = renderMenu(isAdmin(ctx));
  return ctx.reply(view.text, helpExtra(view));
});

bot.command('myid', (ctx) => ctx.reply(`🆔 ${b('Your Telegram ID')}\n${code(ctx.from.id)}${isAdmin(ctx) ? `\n\n✅ ${i('You are an admin.')}` : ''}`));

// /download and the old /site both just take a link; every request saves the whole site now
for (const cmd of ['download', 'site']) {
  bot.command(cmd, async (ctx) => {
    const L = await Lof(ctx);
    const urls = extractUrls(restOf(ctx));
    if (!urls.length) return ctx.reply(L.MSG.usageDownload);
    handleRequest(ctx, urls[0].url.href, { extraLinks: urls.length - 1 }).catch(console.error);
  });
}

bot.command('preview', async (ctx) => {
  const L = await Lof(ctx);
  const urls = extractUrls(restOf(ctx));
  if (!urls.length) return ctx.reply(L.MSG.usagePreview);
  if (await authorize(ctx, L)) sendPreview(ctx, urls[0].url.href, L).catch(console.error);
});

// ---- history: tap to resend, ✖ to remove one, 🗑 to clear all ----
async function historyView(L, uid) {
  const rows = await db.history(uid, 8);
  if (!rows.length) return { text: L.MSG.historyEmpty };
  const kb = rows.map((r) => [
    Markup.button.callback(`${(r.title || r.host).slice(0, 28)} • ${L.ago(Date.now() - new Date(r.created_at).getTime())}`, `h:${r.id}`),
    Markup.button.callback('✖', `hx:${r.id}`),
  ]);
  kb.push([Markup.button.callback(L.BTN.clearAll, 'hc')]);
  return { text: L.MSG.historyTitle, markup: Markup.inlineKeyboard(kb) };
}
const editView = (ctx, view, extra = {}) => ctx.editMessageText(view.text, { ...(view.markup ?? NO_KB), ...extra }).catch(() => {});

bot.command('history', async (ctx) => {
  const L = await Lof(ctx);
  if (!db.enabled()) return ctx.reply(L.MSG.historyOff);
  if (!(await authorize(ctx, L))) return;
  const view = await historyView(L, ctx.from.id);
  await ctx.reply(view.text, view.markup);
});

bot.action(/^h:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const L = await Lof(ctx);
  if (!(await authorize(ctx, L))) return;
  const row = await db.getDownload(ctx.match[1], ctx.from.id);
  if (!row?.tg_file_id) return ctx.reply(L.MSG.fileGone);
  const ok = await sendStored(ctx, {
    fileId: row.tg_file_id, caption: row.caption || `✅ ${row.host}`,
    at: new Date(row.created_at).getTime(), urlKey: row.url_key,
  }, 'history', L);
  if (!ok) await ctx.reply(L.MSG.fileGone);
});

bot.action(/^hx:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const L = await Lof(ctx);
  await db.removeHistoryItem(ctx.match[1], ctx.from.id);
  await editView(ctx, await historyView(L, ctx.from.id));
});
bot.action('hc', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const L = await Lof(ctx);
  await editView(ctx, { text: L.MSG.historyAsk, markup: Markup.inlineKeyboard([[Markup.button.callback(L.BTN.yesClear, 'hcy'), Markup.button.callback(L.BTN.keep, 'hcn')]]) });
});
bot.action('hcn', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await editView(ctx, await historyView(await Lof(ctx), ctx.from.id));
});
bot.action('hcy', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const L = await Lof(ctx);
  await db.clearHistory(ctx.from.id);
  await editView(ctx, { text: L.MSG.historyCleared });
});

// ---- privacy: what is kept, auto-delete choice, delete everything ----
const RET = [['7', 7, 'd7'], ['30', 30, 'd30'], ['0', 0, 'never']];
async function privacyView(L, uid) {
  const cur = await db.getRetention(uid); // null = default, 0 = never
  const label = (days) => (days == null ? L.MSG.retention.def(CFG.retentionDays) : days === 0 ? L.MSG.retention.never : days === 7 ? L.MSG.retention.d7 : days === 30 ? L.MSG.retention.d30 : `${days}`);
  const mark = (on) => (on ? '✓ ' : '');
  const kb = [
    RET.map(([cb, days, k]) => Markup.button.callback(`${mark(cur === days)}${L.MSG.retention[k]}`, `pv:${cb}`)),
    [Markup.button.callback(`${mark(cur == null)}${L.MSG.retention.def(CFG.retentionDays)}`, 'pv:d')],
    [Markup.button.callback(L.BTN.deleteData, 'pd')],
  ];
  return { text: L.MSG.privacy(label(cur)), markup: Markup.inlineKeyboard(kb), extra: { parse_mode: 'HTML' } };
}
bot.command('privacy', async (ctx) => {
  const L = await Lof(ctx);
  if (!db.enabled()) return ctx.reply(L.MSG.historyOff);
  const v = await privacyView(L, ctx.from.id);
  await ctx.reply(v.text, { ...v.markup, ...v.extra });
});
bot.action(/^pv:(7|30|0|d)$/, async (ctx) => {
  const L = await Lof(ctx);
  const v = ctx.match[1];
  await db.setRetention(ctx.from.id, v === 'd' ? null : Number(v));
  await ctx.answerCbQuery('✓').catch(() => {});
  const view = await privacyView(L, ctx.from.id);
  await editView(ctx, view, view.extra);
});
bot.action('pd', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const L = await Lof(ctx);
  await editView(ctx, { text: L.MSG.deleteAsk, markup: Markup.inlineKeyboard([[Markup.button.callback(L.BTN.yesDelete, 'pdy'), Markup.button.callback(L.BTN.keep, 'pdn')]]) });
});
bot.action('pdn', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const view = await privacyView(await Lof(ctx), ctx.from.id);
  await editView(ctx, view, view.extra);
});
bot.action('pdy', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const L = await Lof(ctx);
  await db.purgeUser(ctx.from.id);
  await langStore.set(ctx.from.id, null);
  await editView(ctx, { text: L.MSG.deleted });
});

// ---- language ----
bot.command('language', async (ctx) => {
  const L = await Lof(ctx);
  const kb = [...chunk2(Object.entries(LANGS).map(([code, name]) => Markup.button.callback(`${code === L.lang ? '✓ ' : ''}${name}`, `lg:${code}`))),
    [Markup.button.callback(L.MSG.langAuto, 'lg:auto')]];
  await ctx.reply(L.MSG.langPick, Markup.inlineKeyboard(kb));
});
bot.action(/^lg:(auto|[a-z]{2})$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const pick = ctx.match[1];
  await langStore.set(ctx.from.id, pick === 'auto' ? null : (LANGS[pick] ? pick : null));
  const L = await Lof(ctx);
  await ctx.editMessageText(L.MSG.langSet(pick === 'auto' ? L.MSG.langAuto.replace(/^🌐 /, '') : LANGS[pick]), NO_KB).catch(() => {});
});

// ---- admin ----
bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return denyAdmin(ctx);
  const st = db.enabled() ? await db.stats() : null;
  const pct = (x, y) => (Number(y) ? Math.round((Number(x) / Number(y)) * 100) : null);
  const pctText = (v) => (v == null ? '–' : `${v}%`);
  const br = browserStats();
  const lines = [
    `📊 ${b('Website Downloader')}  ${code(`v${pkg.version}`)}`,
    `${kvMode === 'redis' ? '🟢' : '🟡'} Redis ${code(kvMode)}  ·  ${db.enabled() ? '🟢' : '🟡'} Postgres ${code(db.enabled() ? 'on' : 'off')}  ·  ${br.up ? '🟢' : '⚪'} Chromium ${code(br.up ? 'up' : 'idle')}`,
    `🚦 Queue ${code(`${queue.active} active`)} ${code(`${queue.waiting.length} waiting`)} ${code(`${flights.size} in flight`)}`,
  ];
  if (st) {
    const success = pct(st.ok, st.total);
    lines.push(
      '', b('Activity'),
      `👥 Users  ${code(st.users)}`,
      `📥 Downloads  ${code(st.total)}  ·  last 24h ${code(st.last24h)}`,
      `${dot(success, 80, 60, true)} Success  ${code(pctText(success))}`,
      `⚡ Cache hits  ${code(pctText(pct(st.cached, st.total)))}`,
      `⏱ Average build  ${code(fmtMs(st.avg_ms))}`
    );
    const p = st.phases;
    if (p && Number(p.jobs) > 0) {
      lines.push('', `${b('Where the time goes')}  ${i(`7 days · ${p.jobs} builds · ${pctText(pct(p.browser_jobs, p.jobs))} used the browser`)}`,
        table([['fetch', fmtMs(p.fetch)], ['browser', fmtMs(p.browser)], ['assets', fmtMs(p.assets)], ['zip', fmtMs(p.zip)], ['upload', fmtMs(p.upload)]]));
    }
    if (st.hosts.length) lines.push(b('Top sites') + `  ${i('7 days')}`, ...st.hosts.map((h, n) => `${n + 1}. ${esc(h.host)}  ·  ${code(h.c)}`), '');
    if (st.errors.length) lines.push(b('Top failures') + `  ${i('7 days')}`, ...st.errors.map((e) => `• ${esc(e.code)}  ·  ${code(e.c)}`));
  }
  await ctx.reply(lines.join('\n').trim());
});

for (const [cmd, flag] of [['ban', true], ['unban', false]]) {
  bot.command(cmd, async (ctx) => {
    if (!isAdmin(ctx)) return denyAdmin(ctx);
    const L = await Lof(ctx);
    const id = Number(argOf(ctx));
    if (!Number.isInteger(id)) return ctx.reply(`${b('Usage')}  ${code(`/${cmd} <telegram_id>`)}`);
    if (flag && CFG.adminIds.includes(id)) return ctx.reply(L.MSG.adminSelf);
    const ok = await db.setBanned(id, flag);
    await ctx.reply(ok ? `${flag ? '🚫' : '✅'} ${code(id)} ${flag ? 'banned' : 'unbanned'}.` : `⚠️ ${i('User not found (or Postgres is off).')}`);
  });
}

// null = the check failed
const timeIt = async (fn) => { const t = Date.now(); try { await fn(); return Date.now() - t; } catch { return null; } };

// Is it alive, how long has it been up, how fast are its parts? (admins only)
bot.command('ping', async (ctx) => {
  if (!isAdmin(ctx)) return denyAdmin(ctx);
  const t0 = Date.now();
  const m = await ctx.reply('🏓 …');
  const tg = Date.now() - t0; // a full round trip to Telegram
  const [redis, pg] = await Promise.all([timeIt(() => kv.get('ping')), db.enabled() ? timeIt(() => db.ping()) : Promise.resolve(undefined)]);
  const br = browserStats();
  const share = memoryShare();
  const lat = (v) => (v === undefined ? `${code('off')} 🟡` : v === null ? `${code('error')} 🔴` : `${code(fmtMs(v))} ${dot(v, 100, 500)}`);
  const text = [
    `🏓 ${b('Pong')}  ${code(fmtMs(tg))} ${dot(tg, 800, 2000)}`,
    '',
    `🟢 ${b(`v${pkg.version}`)}  ·  Node ${process.versions.node}`,
    `⏱ Up ${code(fmtUptime(Date.now() - startedAt))}  ${i(`since ${utc(startedAt)}`)}`,
    '',
    b('Resources'),
    `💾 Memory  ${code(`${memoryMb()} MB`)}${share == null ? '' : `  ·  container ${code(`${Math.round(share * 100)}%`)} ${dot(share * 100, 70, 85)}`}`,
    `🗄 Redis ${kvMode === 'redis' ? lat(redis) : `${code('memory only')} 🟡`}  ·  Postgres ${lat(pg)}`,
    `🧭 Chromium ${br.up ? '🟢 up' : '⚪ idle'}  ·  ${br.active} active  ·  ${br.served} served  ·  ${br.crashes} crashes`,
    `🚦 Queue  ${queue.active} active  ·  ${queue.waiting.length} waiting  ·  ${flights.size} in flight`,
  ].join('\n');
  await ctx.telegram.editMessageText(ctx.chat.id, m.message_id, undefined, text).catch(() => ctx.reply(text));
});

bot.command('block', async (ctx) => {
  if (!isAdmin(ctx)) return denyAdmin(ctx);
  const arg = argOf(ctx);
  if (!arg) {
    const list = policy.blockedList();
    return ctx.reply(list.length ? `🚫 ${b('Blocked domains')}  ${i('subdomains included')}\n${list.map((d) => `• ${code(d)}`).join('\n')}\n\n${i('/block domain.com  ·  /unblock domain.com')}` : `🚫 ${b('No blocked domains')}\n${i('Usage: /block domain.com')}`);
  }
  if (!policy.validDomain(arg)) return ctx.reply(`${b('Usage')}  ${code('/block domain.com')}`);
  const d = await policy.addBlocked(arg, ctx.from.id);
  await ctx.reply(`🚫 ${code(d)} ${i('and its subdomains are now blocked.')}`);
});
bot.command('unblock', async (ctx) => {
  if (!isAdmin(ctx)) return denyAdmin(ctx);
  const arg = argOf(ctx);
  if (!arg) return ctx.reply(`${b('Usage')}  ${code('/unblock domain.com')}`);
  const had = await policy.removeBlocked(arg);
  await ctx.reply(had ? `✅ ${code(arg)} ${i('unblocked.')}` : `ℹ️ ${code(arg)} ${i("wasn't blocked.")}`);
});

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

// Fresh copy / Try again (and the old 🧭 button on messages sent by earlier versions: browser mode is automatic now)
bot.action(/^(?:rs?|b):([a-f0-9]{40})$/, async (ctx) => {
  const L = await Lof(ctx);
  await ctx.answerCbQuery('🔄').catch(() => {});
  const url = await cache.urlFor(ctx.match[1]);
  if (!url) return ctx.reply(L.MSG.refreshLost);
  handleRequest(ctx, url, { force: true }).catch(console.error);
});

bot.action(/^p:([a-f0-9]{40})$/, async (ctx) => {
  const L = await Lof(ctx);
  await ctx.answerCbQuery('🖼').catch(() => {});
  if (!(await authorize(ctx, L))) return;
  const url = await cache.urlFor(ctx.match[1]);
  if (!url) return ctx.reply(L.MSG.previewLost);
  sendPreview(ctx, url, L).catch(console.error);
});

// ✖ Cancel under the progress message
bot.action(/^x:([a-f0-9]{40})$/, async (ctx) => {
  const L = await Lof(ctx);
  const f = flights.get(ctx.match[1]);
  const me = f?.members.get(ctx.from.id);
  if (!f || !me) return ctx.answerCbQuery(L.MSG.cancelNone).catch(() => {});
  if (me.leader && f.members.size > 1) return ctx.answerCbQuery(L.MSG.cancelOthers, { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery(L.STATUS.cancelling).catch(() => {});
  if (me.leader) { me.update(L.STATUS.cancelling); f.controller.abort(); } // the job notices at its next checkpoint
  else { me.cancelled = true; f.members.delete(ctx.from.id); me.update(L.STATUS.cancelled, null); }
});

// a link anywhere in a message: "check out https://x.com/a, it's great" works
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/') || ctx.chat.type !== 'private') return;
  const urls = extractUrls(text);
  if (!urls.length) return ctx.reply((await Lof(ctx)).MSG.noLink);
  handleRequest(ctx, urls[0].url.href, { extraLinks: urls.length - 1 }).catch(console.error);
});

// ---------- previews ----------
async function sendPreview(ctx, rawUrl, L) {
  let parsed;
  try { parsed = normalizeUrl(rawUrl); }
  catch (e) { return ctx.reply(L.errorText(codeOf(e))); }
  if (!isAdmin(ctx) && policy.isBlocked(parsed.url.hostname)) return ctx.reply(L.errorText('blocked_domain'));
  const key = urlKey(parsed.url);

  const cachedId = await previews.get(key);
  if (cachedId) {
    try { await ctx.replyWithPhoto(cachedId, { caption: L.previewCaption(parsed.url.host) }); return; }
    catch { /* stale file_id: take a new one */ }
  }
  if (!CFG.enableBrowser) return ctx.reply(L.MSG.previewOff);
  if (!isAdmin(ctx) && !(await previews.cooldownOk(ctx.from.id))) return ctx.reply(L.MSG.previewWait);

  const status = await ctx.reply(L.STATUS.preview);
  const edit = (t) => ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, t).catch(() => {});
  try {
    try { await assertPublicHost(parsed.url.hostname); }
    catch (e) { throw explainNetError(e, parsed.url.host); }
    const buf = await browserSem.run(() => screenshotPage(parsed.url.href));
    const sent = await ctx.replyWithPhoto({ source: buf }, { caption: L.previewCaption(parsed.url.host) });
    previews.set(key, sent.photo[sent.photo.length - 1].file_id);
    ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
  } catch (e) {
    if (e instanceof UserError) return edit(L.errorText(e.code));
    console.error('preview failed:', e?.message);
    return edit(/ERR_NAME_NOT_RESOLVED/.test(String(e?.message)) ? L.errorText('dns') : L.MSG.previewFail);
  }
}

// ---------- sending saved results ----------
// One ZIP: the summary is its caption. Several: the summary arrives first as a message, then "Part i of n".
async function sendStored(ctx, data, label, L) {
  try {
    ctx.sendChatAction('upload_document').catch(() => {});
    const ids = String(data.fileId).split(',').filter(Boolean);
    const main = L.caption(data.caption);
    // a result someone else just built looks like a normal fresh result: no "from cache" footer
    const footer = label === 'shared' ? '' : `\n\n${i(L.CAP.footer(label, L.ago(Date.now() - data.at)))}`;
    if (ids.length > 1) await ctx.reply(`${main}${footer}\n\n${i(L.CAP.partsHint(ids.length))}`.slice(0, 4000));
    for (let k = 0; k < ids.length; k++) {
      const extra = { caption: ids.length > 1 ? b(L.CAP.part(k + 1, ids.length)) : `${main}${footer}`.slice(0, 1000) };
      if (k === ids.length - 1 && data.urlKey) Object.assign(extra, keyboard(L, data.urlKey, { refresh: label !== 'shared' }));
      await ctx.replyWithDocument(ids[k], extra);
    }
    return true;
  } catch (e) {
    if (/file|bad request/i.test(String(e?.message))) await db.invalidateFile(data.fileId);
    return false;
  }
}

// ---------- core flow ----------
async function handleRequest(ctx, raw, { force = false, resumed = false, rec = null, extraLinks = 0 } = {}) {
  const uid = ctx.from.id;
  const admin = isAdmin(ctx);
  const L = await Lof(ctx);
  if (!admin && CFG.allowedUsers.length && !CFG.allowedUsers.includes(uid))
    return ctx.reply(L.MSG.notAuthorized);

  let parsed;
  try { parsed = normalizeUrl(raw); }
  catch (e) { return ctx.reply(L.errorText(codeOf(e))); }
  const host = bareHost(parsed.url.hostname);
  if (!admin && policy.isBlocked(host)) return ctx.reply(L.errorText('blocked_domain'));
  if (!admin && !resumed) {
    const paused = await policy.strikes.pausedMs(uid);
    if (paused > 0) return ctx.reply(L.MSG.paused(Math.ceil(paused / 60000)));
  }
  // one key family for whole-site results
  const key = sectionKey(urlKey(parsed.url));
  const base = { userId: uid, url: parsed.url.href, urlKey: key, host: parsed.url.host };

  // user check + both caches in parallel: one round-trip of latency, not three
  const [user, hit, neg] = await Promise.all([
    resumed ? null : db.touchUser(ctx.from),
    force ? null : cache.getResult(key),
    force ? null : cache.getNegative(key),
  ]);
  if (user?.banned && !admin) return ctx.reply(L.MSG.banned);

  // "Fresh copy" is incremental: ask the site whether anything changed before rebuilding everything
  if (force && !resumed) {
    const prev = await cache.getResult(key);
    if (prev) {
      const note = await ctx.reply(L.STATUS.changes).catch(() => null);
      const verdict = await fingerprint.probe(key).catch(() => null);
      if (note) ctx.telegram.deleteMessage(ctx.chat.id, note.message_id).catch(() => {});
      if (verdict === 'unchanged' && (await sendStored(ctx, prev, 'unchanged', L))) {
        await ctx.reply(L.MSG.unchanged).catch(() => {});
        db.record({ ...base, status: 'ok', mode: prev.mode, cached: true, files: prev.files, zipBytes: prev.zipBytes, durationMs: 0, fileId: prev.fileId, fileName: prev.fileName, caption: prev.caption, title: prev.title });
        return;
      }
    }
  }

  if (extraLinks > 0) await ctx.reply(L.MSG.moreLinks(extraLinks + 1)).catch(() => {});

  if (hit) {
    if (await sendStored(ctx, hit, 'cache', L)) {
      db.record({ ...base, status: 'ok', mode: hit.mode, cached: true, files: hit.files, zipBytes: hit.zipBytes, durationMs: 0, fileId: hit.fileId, fileName: hit.fileName, caption: hit.caption, title: hit.title });
      return;
    }
    await cache.dropResult(key); // stale file_id: rebuild below
  }
  if (neg) {
    cache.rememberUrl(key, parsed.url.href);
    const retry = L.failureActions(neg.code).length > 0;
    return ctx.reply(retry ? `${neg.message}\n\n${i(L.MSG.retrySoon)}` : neg.message, failureMarkup(L, neg.code, key) ?? undefined);
  }

  let held = false;
  let ran = false;
  try {
    if (!admin && !resumed) {
      if (!(await limits.tryAcquire(uid))) return ctx.reply(L.MSG.busy);
      held = true;
      const wait = await limits.cooldownLeft(uid);
      if (wait > 0) return ctx.reply(L.MSG.cooldown(Math.ceil(wait / 1000)));
      if (CFG.dailyLimit) {
        const used = await quota.consume(uid);
        if (used > CFG.dailyLimit) return ctx.reply(L.MSG.daily(CFG.dailyLimit));
      }
      if (!flights.has(key)) { // joining someone else's build costs nothing
        if (CFG.domainDailyCap && (await quota.domain(uid, host)) > CFG.domainDailyCap)
          return ctx.reply(L.MSG.domainCap(CFG.domainDailyCap, host));
        if (CFG.domainGlobalDaily && (await quota.domainGlobal(host)) > CFG.domainGlobalDaily)
          return ctx.reply(L.MSG.siteBusyToday(host));
      }
    }
    ran = (await build(ctx, parsed, key, base, { L, resumed, rec })) !== false;
  } finally {
    if (held) await limits.release(uid, ran);
    else if (resumed && !admin) await limits.release(uid, false); // the lock from before the restart
  }
}

async function build(ctx, parsed, key, base, opts) {
  const { L } = opts;
  const S = L.STATUS;
  const uid = ctx.from.id;
  const admin = isAdmin(ctx);
  const started = Date.now();

  // register the flight synchronously, so two simultaneous requests can never both become leaders
  let f = flights.get(key);
  const leader = !f;
  let settle;
  if (leader) {
    f = { controller: new AbortController(), members: new Map(), promise: null };
    f.promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    flights.set(key, f);
    f.promise.finally(() => flights.delete(key)).catch(() => {});
  }
  const cancelKb = Markup.inlineKeyboard([[Markup.button.callback(L.BTN.cancel, `x:${key}`)]]);
  const first = opts.resumed ? S.resuming
    : !leader ? S.shared
      : queue.load >= CFG.queueConcurrency ? S.queued(queue.waiting.length + 1)
        : S.starting(parsed.url.host);
  let status;
  try {
    if (opts.rec?.statusId) {
      status = { message_id: opts.rec.statusId };
      const ok = await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, first, cancelKb).then(() => true, () => false);
      if (!ok) status = await ctx.reply(first, cancelKb);
    } else {
      status = await ctx.reply(first, cancelKb);
    }
  } catch (e) {
    if (leader) settle.reject(e); // never leave a flight that nobody will finish
    throw e;
  }
  const update = makeUpdater(ctx, status, cancelKb);
  f.members.set(uid, { leader, update, cancelled: false });

  // remember the job so a restart can pick it up again
  const recId = opts.rec?.id || `${key}:${uid}:${started}`;
  await resume.register(recId, {
    uid, chatId: ctx.chat.id, url: parsed.url.href, key, lang: L.lang, statusId: status.message_id,
    startedAt: opts.rec?.startedAt || started, attempts: opts.rec?.attempts || 0,
  });

  try {
    if (leader) {
      try { queue.add(() => produce(ctx, parsed, key, update, { L, signal: f.controller.signal })).then(settle.resolve, settle.reject); }
      catch (e) { settle.reject(e); } // QUEUE_FULL
    }
    const data = await f.promise;
    if (!leader) {
      if (!f.members.has(uid)) return false; // this person cancelled while waiting
      if (!(await sendStored(ctx, data, 'shared', L))) throw new UserError('could not resend shared result', 'send_failed');
    }
    await update.flush();
    ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    db.record({
      ...base, status: 'ok', mode: data.mode, cached: !leader, files: data.files, zipBytes: data.zipBytes,
      durationMs: Date.now() - started, fileId: data.fileId, fileName: data.fileName, caption: data.caption,
      title: data.title, timings: leader ? data.timings : null,
    });
    if (leader) recordJob(true);
    if (!admin) policy.strikes.clear(uid);
    return true;
  } catch (e) {
    // the process is shutting down (deploy): say nothing and keep the job registered, the next start resumes it
    if (stopping) return false;
    const code = codeOf(e);
    if (code === 'cancelled') {
      update(S.cancelled, null);
      await update.flush();
      return false;
    }
    // precise detail stays in the logs and database; the user gets a short human message
    const text = L.errorText(code);
    if (code === 'internal') console.error('job failed:', e);
    else console.warn(`[job] ${code} ${parsed.url.host}: ${e?.message}`);
    cache.rememberUrl(key, parsed.url.href); // lets the Try again button find the link
    update(text, failureMarkup(L, code, key));
    if (leader && e instanceof UserError) cache.setNegative(key, { message: text, code }, code === 'zip_too_big' ? 6 * 60 * 60 * 1000 : CFG.negTtlMs);
    await update.flush();
    if (leader) recordJob(false, code);
    if (!admin) policy.strikes.fail(uid, code);
    db.record({ ...base, status: 'failed', errorCode: code, durationMs: Date.now() - started });
    return false;
  } finally {
    f.members.delete(uid);
    if (!stopping) resume.finish(recId);
  }
}

// build + upload once; the Telegram file_id is what every later request reuses
async function produce(ctx, parsed, key, update, { L, signal }) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-'));
  try {
    if (signal.aborted) throw new UserError('cancelled', 'cancelled');
    const r = await downloadWebsite(parsed, workDir, update, { L, signal });
    const parts = r.parts;
    const n = parts.length;
    const caption = JSON.stringify(buildSummary(r, n)); // structured: each reader sees it in their own language
    if (signal.aborted) throw new UserError('cancelled', 'cancelled');

    // several ZIPs: the summary comes first, then every part is labelled "Part i of n"
    if (n > 1) await ctx.reply(`${L.caption(caption)}\n\n${i(L.CAP.partsHint(n))}`.slice(0, 4000)).catch(() => {});
    const tu = Date.now();
    const ids = [];
    for (let k = 0; k < n; k++) {
      update(L.STATUS.sending(k + 1, n));
      ctx.sendChatAction('upload_document').catch(() => {});
      const msg = await ctx.replyWithDocument(
        { source: parts[k].zipPath, filename: parts[k].zipName },
        {
          caption: n > 1 ? b(L.CAP.part(k + 1, n)) : L.caption(caption),
          ...(k === n - 1 ? keyboard(L, key, { refresh: false }) : {}),
        }
      );
      ids.push(msg.document.file_id);
    }
    r.timings.upload = Date.now() - tu;
    const data = {
      urlKey: key, fileId: ids.join(','), fileName: parts[0].zipName, caption, title: r.title,
      host: r.host, mode: r.mode, files: r.fileCount, zipBytes: r.zipBytes,
      at: Date.now(), timings: r.timings,
    };
    await Promise.all([cache.setResult(key, data), cache.rememberUrl(key, parsed.url.href), fingerprint.save(key, r.fingerprint)]);
    return data;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- resume jobs that a restart cut off ----------
async function resumeJobs() {
  const list = await resume.unfinished();
  if (!list.length) return 0;
  console.log(`Resuming ${list.length} unfinished job(s) from before the restart`);
  for (const j of list) {
    const ctx = resume.makeContext(bot.telegram, j);
    if (j.expired) {
      await resume.finish(j.id);
      await limits.release(j.uid, false);
      const L = tr(j.lang);
      let host = j.url; try { host = new URL(j.url).host; } catch { /* keep the raw text */ }
      if (j.statusId) bot.telegram.editMessageText(j.chatId, j.statusId, undefined, L.MSG.restartLost(host), NO_KB).catch(() => ctx.reply(L.MSG.restartLost(host)).catch(() => {}));
      continue;
    }
    handleRequest(ctx, j.url, { resumed: true, rec: { ...j, attempts: (j.attempts || 0) + 1 } }).catch((e) => console.error('resume failed:', e?.message));
  }
  return list.filter((j) => !j.expired).length;
}

// ---------- telling admins what the bot is doing ----------
async function notifyAdmins(text) {
  if (!CFG.adminNotify) return;
  for (const id of CFG.adminIds) await bot.telegram.sendMessage(id, text).catch(() => {});
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// "I'm online": version, what is connected, and how many interrupted jobs were picked up again
async function announceStartup(warm, resumed) {
  if (!CFG.adminNotify || !CFG.adminIds.length) return;
  if (!(await kv.setNx('boot-notice', '1', 20_000))) return; // a crash loop must not spam admins
  const ready = CFG.enableBrowser ? (await Promise.race([warm, sleepMs(25_000).then(() => 'slow')])) === true : null;
  let username = '';
  try { username = ` @${(await bot.telegram.getMe()).username}`; } catch { /* still online */ }
  const ok = (v) => (v ? '🟢' : '🟡');
  await notifyAdmins([
    `🟢 ${b(`Website Downloader v${pkg.version}`)} is online${esc(username)}`,
    i(utc(Date.now())),
    '',
    `${ok(kvMode === 'redis')} Redis  ·  ${ok(db.enabled())} Postgres  ·  ${ready === null ? '⚪ Chromium off' : `${ok(ready)} Chromium${ready ? '' : ' not ready'}`}`,
    ...(resumed ? [`🔄 Resuming ${b(resumed)} interrupted job${resumed === 1 ? '' : 's'}`] : []),
    '',
    i('Send /ping for live health.'),
  ].join('\n'));
}

// ---------- lifecycle ----------
bot.catch((err) => console.error('bot error:', err));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

async function main() {
  console.log(`Website Downloader v${pkg.version} starting…`);
  await initStore();
  await db.init();
  db.startRetention();
  const blockedCount = await policy.loadBlocked();
  if (blockedCount) console.log(`Blocked domains: ${blockedCount}`);
  setNotifier((text) => notifyAdmins(text));
  startHealth(() => ({
    version: pkg.version, stopping, queue: { active: queue.active, waiting: queue.waiting.length, flights: flights.size },
    redis: kvMode, postgres: db.enabled(),
  }));
  const warm = CFG.enableBrowser
    ? warmBrowser().then(() => { console.log('Chromium warmed up'); return true; }).catch((e) => { console.error('Chromium warm-up failed:', e.message); return false; })
    : Promise.resolve(false);

  // the menu stays short; everything else still works when typed
  const commands = [
    { command: 'start', description: 'Welcome and quick start' },
    { command: 'help', description: 'What I can do, with guides' },
    { command: 'history', description: 'Your recent downloads' },
    { command: 'privacy', description: 'Your data and auto-delete' },
  ];
  const adminCommands = [
    ...commands,
    { command: 'ping', description: 'Admin: is it alive? uptime and speed' },
    { command: 'stats', description: 'Admin: usage, speed and errors' },
    { command: 'ban', description: 'Admin: /ban <telegram_id>' },
    { command: 'unban', description: 'Admin: /unban <telegram_id>' },
    { command: 'block', description: 'Admin: /block domain.com (list without a domain)' },
    { command: 'unblock', description: 'Admin: /unblock domain.com' },
  ];
  // makes Telegram's menu match the code exactly, including removing commands registered earlier (e.g. /browser)
  syncCommands(bot.telegram, { commands, adminCommands, adminIds: CFG.adminIds }).catch((e) => console.error('Commands sync failed:', e?.message));
  if (CFG.adminIds.length) console.log(`Admins: ${CFG.adminIds.join(', ')}`);
  else console.log('ADMIN_IDS not set: /ping, /stats, /ban, /block are disabled. Message the bot /myid to get your ID.');

  syncProfile(bot.telegram).catch((e) => console.error('Profile sync failed:', e?.message));

  bot.launch({ dropPendingUpdates: true }).catch((e) => { console.error(e); process.exit(1); });
  console.log('Website Downloader (@WebsiteDownloaderBot) is running.');
  const resumed = await resumeJobs().catch((e) => { console.error('resume error:', e?.message); return 0; });
  announceStartup(warm, resumed).catch((e) => console.warn('startup notice failed:', e?.message));
}

async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 8000).unref();
  // tell admins before going quiet (deploys send SIGTERM); jobs in flight are picked up again by the next start
  await Promise.race([notifyAdmins(`🔴 ${b(`Website Downloader v${pkg.version} is shutting down`)}\n${i(`${sig} after ${fmtUptime(Date.now() - startedAt)}. Unfinished jobs resume on the next start.`)}`), sleepMs(3000)]);
  try { bot.stop(sig); } catch { /* not started */ }
  await Promise.allSettled([closeBrowser(), closeStore(), db.shutdown()]);
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch((e) => { console.error('Fatal startup error:', e); process.exit(1); });

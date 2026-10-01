import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Telegraf } from 'telegraf';
import { CFG, mb } from './config.js';
import { normalizeUrl } from './url.js';
import { downloadSite } from './downloader.js';
import { JobQueue } from './queue.js';
import { UserError } from './errors.js';

if (!CFG.token) {
  console.error('BOT_TOKEN is not set.');
  process.exit(1);
}

const bot = new Telegraf(CFG.token, { handlerTimeout: 10 * 60 * 1000 });
const queue = new JobQueue(CFG.queueConcurrency, CFG.queueMaxWaiting);
const busy = new Set();          // users with a job in flight
const lastFinished = new Map();  // userId -> timestamp (cooldown)

const HELP = [
  '👋 Website Downloader',
  '',
  "Send me a website link and I'll send back a ZIP of its frontend (HTML, CSS, JS, images, fonts). Unzip it and open index.html.",
  '',
  'Any of these work:',
  'example.com',
  'www.example.com/path',
  'https://sub.example.co.ke',
].join('\n');

bot.start((ctx) => ctx.reply(HELP));
bot.help((ctx) => ctx.reply(HELP));

bot.command('download', (ctx) => {
  const arg = ctx.message.text.split(/\s+/)[1];
  if (!arg) return ctx.reply('Usage: /download example.com');
  handleRequest(ctx, arg).catch(console.error);
});

bot.on('text', (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/') || ctx.chat.type !== 'private') return;
  handleRequest(ctx, text).catch(console.error);
});

async function handleRequest(ctx, raw) {
  const uid = ctx.from.id;
  if (CFG.allowedUsers.length && !CFG.allowedUsers.includes(uid))
    return ctx.reply("Sorry, you're not authorized to use this bot.");

  let parsed;
  try { parsed = normalizeUrl(raw); }
  catch (e) { return ctx.reply(`❌ ${e.message}`); }

  if (busy.has(uid)) return ctx.reply('⏳ You already have a download running. Please wait for it to finish.');
  const wait = (lastFinished.get(uid) || 0) + CFG.cooldownMs - Date.now();
  if (wait > 0) return ctx.reply(`⏳ Please wait ${Math.ceil(wait / 1000)}s before your next request.`);

  busy.add(uid);
  const ahead = queue.load;
  const status = await ctx.reply(
    ahead >= CFG.queueConcurrency ? `📥 Queued (${ahead} ahead of you)…` : `📥 Starting ${parsed.url.host}…`
  );
  const update = (t) => ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, t).catch(() => {});

  try {
    await queue.add(() => runJob(ctx, parsed, status, update));
  } catch (e) {
    await update(e.message === 'QUEUE_FULL' ? '🚦 I\'m busy right now. Please try again in a minute.' : '❌ Something went wrong. Please try again.');
  } finally {
    busy.delete(uid);
    lastFinished.set(uid, Date.now());
  }
}

async function runJob(ctx, parsed, status, update) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-'));
  try {
    const r = await downloadSite(parsed, workDir, update);
    await update('📤 Uploading…');
    await ctx.sendChatAction('upload_document').catch(() => {});

    const lines = [
      `✅ ${r.host}`,
      `📁 ${r.fileCount} files • ${mb(r.zipBytes)} MB • ${r.mode === 'browser' ? 'browser mode' : 'fast mode'}`,
    ];
    if (r.skipped + r.failed > 0) lines.push(`⚠️ ${r.skipped} skipped, ${r.failed} failed (see skipped.txt)`);
    lines.push(...r.warnings);
    lines.push(`Unzip and open index.html${r.mode === 'browser' ? ' (see README.txt)' : ''}`);

    await ctx.replyWithDocument(
      { source: r.zipPath, filename: r.zipName },
      { caption: lines.join('\n').slice(0, 1000) }
    );
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
  } catch (e) {
    if (e instanceof UserError) await update(e.message);
    else {
      console.error('job failed:', e);
      await update('❌ Something went wrong while downloading that site. Please try again or try another link.');
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

bot.catch((err) => console.error('bot error:', err));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

bot.launch({ dropPendingUpdates: true }).catch((e) => { console.error(e); process.exit(1); });
console.log('Website Downloader (@WebsiteDownloaderBot) is running.');

const stop = (sig) => { bot.stop(sig); process.exit(0); };
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

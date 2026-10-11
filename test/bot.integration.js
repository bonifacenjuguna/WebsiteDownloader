// End-to-end test of the REAL index.js against a simulated Telegram. Only three things are replaced: Telegraf (so updates can be
// injected), the browser, and the site download itself (a stub that returns a small ZIP). Everything else, from message handling
// to the archive worker, is the production code.
//
// Run:  npm run test:bot      (needs Node 22.3+, it uses node:test module mocks)
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HarnessTelegram, makeTelegramClass } from './helpers/harness-telegram.js';
import { tgError } from './helpers/fake-telegram.js';
import { htmlProblems } from './helpers/html.js';

if (typeof mock.module !== 'function') {
  test('bot integration: skipped (needs Node 22.3+ and --experimental-test-module-mocks)', { skip: true }, () => {});
} else {
  await run();
}

async function run() {
  Object.assign(process.env, {
    BOT_TOKEN: '123:test', ADMIN_IDS: '999', PROFILE_SYNC: 'false', ENABLE_BROWSER: 'false', HEALTH: 'false',
    COOLDOWN_SEC: '1', DAILY_LIMIT: '0', RESUME: 'false', NODE_ENV: 'test',
    ARCHIVE_MIN_GAP_MS: '0', ARCHIVE_RATE_PER_MIN: '600', // pacing is proven in archive.test.js with a controllable clock; here real time would only slow the run
  });
  for (const k of ['REDIS_URL', 'DATABASE_URL', 'PORT', 'WEBHOOK_DOMAIN', 'LIVE_CHANNEL_ID', 'VAULT_CHANNEL_ID', 'OPS_CHAT_ID']) delete process.env[k];

  const ADMIN = 999; const USER = 111;
  const LIVE = -1001000000001; const VAULT = -1001000000002; const OPS = -1001000000003;
  const world = new HarnessTelegram();
  world.addChat(ADMIN, { type: 'private' }).addChat(USER, { type: 'private' }).addChat(LIVE).addChat(VAULT).addChat(OPS, { type: 'supergroup', is_forum: true, title: 'Ops' });
  world.chats.get(LIVE).title = 'Live'; world.chats.get(VAULT).title = 'Vault';

  // ---- the three replaced modules
  const Telegram = makeTelegramClass(world);
  let bot = null;
  class Telegraf {
    constructor() { this.cmds = {}; this.actions = []; this.ons = {}; this.telegram = new Telegram(); bot = this; }
    start(fn) { this.cmds.start = fn; }
    help(fn) { this.cmds.help = fn; }
    command(name, fn) { for (const n of [].concat(name)) this.cmds[n] = fn; }
    action(re, fn) { this.actions.push([re, fn]); }
    on(type, fn) { this.ons[type] = fn; }
    catch() {}
    use() {}
    launch() { return new Promise(() => {}); }
    stop() {}
    webhookCallback() { return () => {}; }
  }
  const Markup = { inlineKeyboard: (rows) => ({ reply_markup: { inline_keyboard: rows } }), button: { callback: (text, data) => ({ text, callback_data: data }) } };
  mock.module('telegraf', { namedExports: { Telegraf, Telegram, Markup } });

  let buildImpl = null;
  const builds = [];
  mock.module(new URL('../src/site.js', import.meta.url).href, { namedExports: { downloadWebsite: (...a) => buildImpl(...a) } });
  mock.module(new URL('../src/browser.js', import.meta.url).href, {
    namedExports: {
      warmBrowser: async () => {}, verifyBrowser: async () => true, closeBrowser: async () => {}, screenshotPage: async () => Buffer.from('x'),
      browserSem: { run: (f) => f() }, browserStats: () => ({ up: false, active: 0, served: 0, crashes: 0, onDemand: true }),
      recycleIfBloated: async () => false, renderWithBrowser: async () => { throw new Error('no browser in this test'); },
    },
  });
  const { UserError } = await import('../src/errors.js');

  const okBuild = async (parsed, workDir, onStatus) => {
    builds.push(parsed.url.href);
    onStatus('Saving pages');
    const zipPath = path.join(workDir, `${parsed.url.host}.zip`);
    await fs.writeFile(zipPath, 'PK-fake-zip');
    return {
      kind: 'pages', parts: [{ zipPath, zipName: `${parsed.url.host}.zip`, bytes: 11 }], host: parsed.url.host, title: 'Example & <Docs>',
      pages: 3, fileCount: 10, zipBytes: 5_000_000, mode: 'site-pages', warnings: [], skipped: 0, failed: 0, timings: {}, fingerprint: null, preview: null,
    };
  };
  buildImpl = okBuild;

  // ---- start the real bot
  await import('../src/index.js');
  assert.ok(bot, 'index.js created the bot');

  // ---- helpers: act like Telegram delivering updates
  let seq = 9000;
  const ctxFor = ({ userId, chatId = userId, text = '', data = null, messageId = null, markup = null, update = {} }) => ({
    from: { id: userId, language_code: 'en', username: `u${userId}` },
    chat: { id: chatId, type: world.chats.get(chatId)?.type === 'private' ? 'private' : 'supergroup' },
    message: { text, message_id: ++seq }, match: null, telegram: bot.telegram, update,
    reply: (t, extra) => bot.telegram.sendMessage(chatId, t, extra),
    replyWithDocument: (d, extra) => bot.telegram.sendDocument(chatId, d, extra),
    replyWithPhoto: (p, extra) => bot.telegram.sendPhoto(chatId, p, extra),
    sendChatAction: async () => true, answerCbQuery: async () => true,
    editMessageText: (t, extra) => bot.telegram.editMessageText(chatId, messageId, undefined, t, extra),
    deleteMessage: () => bot.telegram.deleteMessage(chatId, messageId),
    callbackQuery: data ? { data, message: { message_id: messageId, reply_markup: markup } } : undefined,
  });
  const say = (userId, text) => {
    const cmd = text.startsWith('/') ? text.split(/\s+/)[0].slice(1).split('@')[0] : null;
    const ctx = ctxFor({ userId, text });
    return cmd ? bot.cmds[cmd](ctx) : bot.ons.text(ctx);
  };
  const tap = async (userId, msg, data) => {
    for (const [re, fn] of bot.actions) {
      const m = typeof re === 'string' ? (re === data ? [data] : null) : re.exec(data); // Telegraf accepts both
      if (m) { const ctx = ctxFor({ userId, chatId: msg.chat, data, messageId: msg.id, markup: msg.markup }); ctx.match = m; return fn(ctx); }
    }
    throw new Error(`no action matches ${data}`);
  };
  const waitFor = async (fn, ms = 9000, what = 'condition') => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const msgs = (chat) => world.messages(chat);
  const text = (m) => m.text ?? m.caption ?? '';
  const buttons = (m) => (m.markup?.inline_keyboard ?? []).flat();
  const findButton = (m, re) => buttons(m).find((b) => re.test(b.callback_data));
  const opsPosts = (topicIndex) => msgs(OPS).filter((m) => m.thread === world.chats.get(OPS).topics[topicIndex]?.id);
  const TOPIC = { alerts: 0, errors: 1, deploys: 2, digest: 3, logs: 4, admin: 5 };

  // =====================================================================
  test('startup: the menu is synced (admin gets more) and admins are told it is online', async () => {
    await waitFor(() => msgs(ADMIN).some((m) => /is online/.test(text(m))), 6000, 'the online message');
    const pub = world.menus.get('default||').map((c) => c.command);
    assert.deepEqual(pub, ['start', 'help', 'history', 'privacy']);
    assert.ok(!pub.includes('browser'));
    const adm = world.menus.get(`chat||${ADMIN}`).map((c) => c.command);
    for (const c of ['ping', 'stats', 'ban', 'block', 'archive']) assert.ok(adm.includes(c), c);
    const online = msgs(ADMIN).find((m) => /is online/.test(text(m)));
    assert.match(text(online), /Redis/);
    assert.match(text(online), /Updates by <b>polling<\/b>/);
    assert.match(text(online), /Archive not connected yet[\s\S]*Live, Vault, Ops[\s\S]*\/archive setup/);   // nobody has to guess why nothing is archived
  });

  test('connecting spaces: adding the bot asks the admin, the buttons connect Live, Vault and Ops', async () => {
    const added = (chat, type, title) => bot.ons.my_chat_member(ctxFor({ userId: ADMIN, chatId: chat, update: { my_chat_member: { chat: { id: chat, type, title }, from: { id: ADMIN }, old_chat_member: { status: 'left' }, new_chat_member: { status: 'administrator' } } } }));
    await added(LIVE, 'channel', 'Live');
    const offer = msgs(ADMIN).filter((m) => /I was added to a chat/.test(text(m))).at(-1);
    assert.ok(offer);
    assert.deepEqual(buttons(offer).map((b) => b.callback_data), [`sp:live:${LIVE}`, `sp:vault:${LIVE}`, `sp:ops:${LIVE}`, `sp:no:${LIVE}`]);
    assert.match(text(offer), /Ops[\s\S]*Turn on Topics|Ops[\s\S]*Topics/);   // a channel cannot be Ops: it says why
    await tap(ADMIN, { chat: ADMIN, id: offer.id, markup: offer.markup }, `sp:live:${LIVE}`);
    assert.match(text(msgs(ADMIN).find((m) => m.id === offer.id)), /is now 📡 <b>Live<\/b>/);

    await added(VAULT, 'channel', 'Vault');
    const offer2 = msgs(ADMIN).filter((m) => /I was added to a chat/.test(text(m))).at(-1);
    await tap(ADMIN, { chat: ADMIN, id: offer2.id, markup: offer2.markup }, `sp:vault:${VAULT}`);

    await added(OPS, 'supergroup', 'Ops');
    const offer3 = msgs(ADMIN).filter((m) => /I was added to a chat/.test(text(m))).at(-1);
    await tap(ADMIN, { chat: ADMIN, id: offer3.id, markup: offer3.markup }, `sp:ops:${OPS}`);
    assert.equal(world.chats.get(OPS).topics.length, 6);
    assert.deepEqual(world.chats.get(OPS).topics.map((t) => t.name), ['🚨 Alerts', '❗ Errors', '🚀 Deploys', '📊 Daily digest', '📜 Logs', '🛡 Admin actions']);
    assert.match(text(msgs(LIVE)[0]), /Connected as Live/);
  });

  test('a chat missing a right is explained, with the buttons kept so it can be fixed and tapped again', async () => {
    const BAD = -1001000000009;
    world.addChat(BAD, { rights: { can_post_messages: true, can_edit_messages: true, can_delete_messages: false } });
    await bot.ons.my_chat_member(ctxFor({ userId: ADMIN, chatId: BAD, update: { my_chat_member: { chat: { id: BAD, type: 'channel', title: 'Bad' }, from: { id: ADMIN }, old_chat_member: { status: 'left' }, new_chat_member: { status: 'administrator' } } } }));
    const offer = msgs(ADMIN).filter((m) => /I was added to a chat/.test(text(m))).at(-1);
    assert.match(text(offer), /needs the right to delete/);
    await tap(ADMIN, { chat: ADMIN, id: offer.id, markup: offer.markup }, `sp:live:${BAD}`);
    const after = msgs(ADMIN).find((m) => m.id === offer.id);
    assert.match(text(after), /Not yet: Live/);
    assert.ok(buttons(after).length >= 3, 'the role buttons are still there');
    await tap(USER, { chat: USER, id: offer.id, markup: offer.markup }, `sp:live:${BAD}`);  // a non-admin pressing it changes nothing
    assert.match(text(msgs(ADMIN).find((m) => m.id === offer.id)), /Not yet: Live/);
  });


  // ---- the native way: Telegram's own chat picker
  const replyKeyboard = (m) => (m.markup?.keyboard ?? []).flat();
  const shareChat = (userId, request_id, chat_id, title = 'picked') => {
    const ctx = ctxFor({ userId });
    ctx.message = { message_id: ++seq, chat_shared: { request_id, chat_id, title } };
    let passed = false;
    return bot.ons.message(ctx, async () => { passed = true; }).then(() => ({ passed }));
  };

  test('native picker: /archive setup offers Telegram\'s chat picker with exactly the right options, plus add-me links', async () => {
    await say(ADMIN, '/archive setup');
    let m = msgs(ADMIN).at(-1);
    assert.match(text(m), /Everything is connected/);
    assert.deepEqual(m.markup, { remove_keyboard: true }, 'nothing missing: the keyboard is removed');

    await say(ADMIN, '/archive unset vault');
    m = msgs(ADMIN).at(-1);
    assert.match(text(m), /Vault[\s\S]*disconnected\. Nothing was deleted/);
    assert.deepEqual(replyKeyboard(m).map((b) => b.text), ['🗄 Choose the Vault channel'], 'the picker comes back for what is missing');

    await say(ADMIN, '/archive setup');
    m = msgs(ADMIN).at(-1);
    assert.match(text(m), /🗄 <b>Vault<\/b>  ⚪ not connected/);
    assert.match(text(m), /📡 <b>Live<\/b>  🟢 Live/);
    const [btn] = replyKeyboard(m);
    assert.deepEqual(btn.request_chat, {
      request_id: 2, chat_has_username: false, request_title: true, chat_is_channel: true,
      user_administrator_rights: { can_post_messages: true }, bot_administrator_rights: { can_post_messages: true },
    });
    assert.equal(m.markup.one_time_keyboard, true);
    assert.match(text(m), /<a href="https:\/\/t\.me\/testbot\?startchannel&amp;admin=post_messages\+edit_messages\+delete_messages">Add me to a channel as admin<\/a>/);
    assert.match(text(m), /<a href="https:\/\/t\.me\/testbot\?startgroup&amp;admin=manage_topics">Add me to the Ops group<\/a>/);
    assert.deepEqual(htmlProblems(text(m)), []);

    // the three buttons, with the right kind of chat and rights each
    await say(ADMIN, '/archive unset live');
    await say(ADMIN, '/archive unset ops');
    await say(ADMIN, '/archive setup');
    const [live, vault, ops] = replyKeyboard(msgs(ADMIN).at(-1)).map((b) => b.request_chat);
    assert.deepEqual([live.request_id, vault.request_id, ops.request_id], [1, 2, 3]);
    assert.deepEqual(live.user_administrator_rights, { can_post_messages: true, can_edit_messages: true, can_delete_messages: true });
    assert.equal(live.chat_is_channel, true);
    assert.equal(ops.chat_is_channel, false);
    assert.equal(ops.chat_is_forum, true);
    assert.deepEqual(ops.bot_administrator_rights, { can_manage_topics: true });
    for (const r of [live, vault, ops]) assert.equal(r.chat_has_username, false, 'private chats only');
  });

  test('native picker: chats chosen in it are connected, one by one, and the keyboard shrinks until it is gone', async () => {
    const { passed } = await shareChat(ADMIN, 1, LIVE, 'Live');
    assert.equal(passed, false, 'a shared chat is handled, not passed on');
    let m = msgs(ADMIN).at(-1);
    assert.match(text(m), /✅ <b>Live<\/b> is now 📡 <b>Live<\/b>/);
    assert.match(text(m), /Still to connect: Vault, Ops/);
    assert.deepEqual(replyKeyboard(m).map((b) => b.request_chat.request_id), [2, 3]);

    await shareChat(ADMIN, 2, VAULT, 'Vault');
    assert.deepEqual(replyKeyboard(msgs(ADMIN).at(-1)).map((b) => b.request_chat.request_id), [3]);

    await shareChat(ADMIN, 3, OPS, 'Ops');
    m = msgs(ADMIN).at(-1);
    assert.match(text(m), /🎉 <b>All three spaces are connected\.<\/b>/);
    assert.deepEqual(m.markup, { remove_keyboard: true });
    assert.equal(world.chats.get(OPS).topics.length, 6, 'no duplicate topics when Ops is connected again');
    await waitFor(() => opsPosts(TOPIC.admin).some((p) => /Space connected/.test(p.text) && /user #[0-9a-f]{4}/.test(p.text)), 6000, 'the Ops admin-action log');
  });

  test('native picker: a chat without the needed rights is explained and offered again; nonsense is refused cleanly', async () => {
    const BAD2 = -1001000000010;
    world.addChat(BAD2, { rights: { can_post_messages: true, can_edit_messages: true, can_delete_messages: false } });
    await shareChat(ADMIN, 1, BAD2, 'Weak');
    const m = msgs(ADMIN).at(-1);
    assert.match(text(m), /Not yet: Live/);
    assert.match(text(m), /needs the right to delete/);
    assert.ok(replyKeyboard(m).some((b) => b.request_chat.request_id === 1), 'Live is offered again');
    await shareChat(ADMIN, 1, -999999999, 'Ghost');
    assert.match(text(msgs(ADMIN).at(-1)), /Not yet: Live[\s\S]*chat not found/);
    await shareChat(ADMIN, 77, LIVE, 'unknown request');                  // not one of ours: ignored
    assert.match(text(msgs(ADMIN).at(-1)), /Not yet: Live[\s\S]*chat not found/, 'nothing new was sent');
    assert.equal(await (async () => { const before = msgs(USER).length; await shareChat(USER, 1, BAD2, 'x'); return msgs(USER).length - before; })(), 0, 'only admins can connect spaces');
    // the real Live is still the real Live
    await say(ADMIN, '/archive setup');
    assert.match(text(msgs(ADMIN).at(-1)), /Everything is connected/);
  });

  test('messages that are not a shared chat pass straight through to the other handlers', async () => {
    const ctx = ctxFor({ userId: USER, text: 'hello' });
    let passed = false;
    await bot.ons.message(ctx, async () => { passed = true; });
    assert.equal(passed, true);
  });

  test('/archive with something missing shows the picker right under the status', async () => {
    await say(ADMIN, '/archive unset vault');
    await say(ADMIN, '/archive');
    const m = msgs(ADMIN).at(-1);
    assert.match(text(m), /🗄 <b>Vault<\/b>  ⚪ not connected/);
    assert.match(text(m), /👆 <i>Tap a button below/);
    assert.deepEqual(replyKeyboard(m).map((b) => b.request_chat.request_id), [2]);
    await shareChat(ADMIN, 2, VAULT, 'Vault');                           // put it back for the rest of the run
    assert.match(text(msgs(ADMIN).at(-1)), /All three spaces are connected/);
  });

  test('/archive shows the three spaces; /archive test passes end to end; non-admins are refused', async () => {
    await say(ADMIN, '/archive');
    const status = msgs(ADMIN).at(-1);
    assert.match(text(status), /📡 <b>Live<\/b>  🟢 Live/);
    assert.match(text(status), /🗄 <b>Vault<\/b>  🟢 Vault/);
    assert.match(text(status), /🛠 <b>Ops<\/b>  🟢 Ops/);
    assert.match(text(status), /memory only/);       // no Postgres in this test: and the bot says so
    await say(ADMIN, '/archive test');
    const result = await waitFor(() => msgs(ADMIN).find((m) => /All checks passed|checks failed/.test(text(m))), 8000, 'the self-test result');
    assert.match(text(result), /All checks passed/, text(result));
    assert.equal(msgs(LIVE).filter((m) => /Self-test/.test(text(m))).length, 0, 'the test leaves nothing behind');
    await say(USER, '/archive');
    assert.match(text(msgs(USER).at(-1)), /admins only/);
  });

  let firstDoc;
  test('a user sends a link inside a sentence: they get the ZIP with a clean card, and it is archived to Live', async () => {
    await say(USER, 'please check https://Example.com/docs?utm_source=x&fbclid=1 thanks');
    firstDoc = await waitFor(() => msgs(USER).find((m) => m.kind === 'document'), 8000, 'the ZIP');
    assert.deepEqual(builds, ['https://example.com/docs']);                     // tracking parameters stripped
    assert.match(firstDoc.caption, /^✅ <b>example\.com<\/b>\nExample &amp; &lt;Docs&gt;\n\n📄 3 pages  ·  🗂 7 files  ·  💾 4\.8 MB$/);
    assert.deepEqual(buttons(firstDoc).map((b) => b.text), ['🖼 Preview']);      // a fresh build offers a preview, not a refresh
    await waitFor(() => !msgs(USER).some((m) => m.kind === 'text' && /Saving|Opening/.test(text(m))), 4000, 'the progress message to be removed');

    const posted = await waitFor(() => msgs(LIVE).find((m) => m.kind === 'document'), 8000, 'the Live post');
    assert.equal(posted.file, firstDoc.file, 'the archive reuses the same Telegram file: no second upload');
    assert.match(posted.caption, /📦 <b>example\.com<\/b>/);
    assert.match(posted.caption, /#example_com #\d{4}_\d{2} #id_[0-9a-f]{6} #site/);
    assert.match(posted.caption, /⏳ <i>Live until /);
    assert.doesNotMatch(JSON.stringify(posted), /111|u111/, 'nothing about the person reaches the archive');

    await say(ADMIN, '/archive example.com');
    const found = await waitFor(() => msgs(ADMIN).filter((m) => /Archive<\/b>  <i>example\.com/.test(text(m))).at(-1), 4000, 'the search result');
    assert.match(text(found), /<a href="https:\/\/t\.me\/c\/1000000001\/\d+">Live<\/a>/);
  });

  test('asking again is instant and is NOT archived twice', async () => {
    await sleep(1200);                                       // the 1 s cooldown between a person's downloads
    const before = msgs(LIVE).filter((m) => m.kind === 'document').length;
    await say(USER, 'example.com/docs');
    const again = await waitFor(() => msgs(USER).filter((m) => m.kind === 'document').at(-1)?.id !== firstDoc.id && msgs(USER).filter((m) => m.kind === 'document').at(-1), 4000, 'the instant copy');
    assert.match(again.caption, /Instant copy · saved just now/);
    assert.deepEqual(buttons(again).map((b) => b.text), ['🔄 Fresh copy', '🖼 Preview']);
    assert.equal(builds.length, 1, 'no second build');
    await sleep(2500);
    assert.equal(msgs(LIVE).filter((m) => m.kind === 'document').length, before, 'an instant copy is not archived again');
  });

  test('the site is gone: the person is offered the archived copy, and gets it', async () => {
    await sleep(1200);
    const copy = msgs(USER).filter((m) => m.kind === 'document').at(-1);
    const fresh = findButton(copy, /^r:/);
    assert.ok(fresh);
    buildImpl = async () => { throw new UserError('dns', 'dns'); };
    await tap(USER, { chat: USER, id: copy.id, markup: copy.markup }, fresh.callback_data);
    const failure = await waitFor(() => msgs(USER).find((m) => m.kind === 'text' && /couldn't find that website/.test(text(m)) && /saved copy/.test(text(m))), 6000, 'the failure with a rescue offer');
    assert.match(text(failure), /<b>[^<]*find that website\.<\/b>/);
    assert.match(text(failure), /📦 I have a saved copy from <b>[A-Z][a-z]{2} \d{1,2}<\/b>\./);
    const rescue = buttons(failure).find((b) => /^ar:\d+$/.test(b.callback_data));
    assert.ok(rescue, 'the rescue button is there');
    assert.match(rescue.text, /^📦 Saved copy · /);
    assert.deepEqual(htmlProblems(text(failure)), []);

    const docsBefore = msgs(USER).filter((m) => m.kind === 'document').length;
    await tap(USER, { chat: USER, id: failure.id, markup: failure.markup }, rescue.callback_data);
    const sent = await waitFor(() => msgs(USER).filter((m) => m.kind === 'document')[docsBefore], 4000, 'the archived copy');
    assert.equal(sent.file, firstDoc.file, 'the very same ZIP is handed back');
    assert.match(sent.caption, /Archived copy · saved /);
    assert.match(sent.caption, /^✅ <b>example\.com<\/b>/);

    // Ops: the failure is a quiet log line (the visitor's problem, not ours), the rescue is noted, and no id appears
    await waitFor(() => opsPosts(TOPIC.logs).some((m) => /saved copy sent/.test(m.text)), 6000, 'the Ops log lines');
    const logs = opsPosts(TOPIC.logs).map((m) => m.text).join('\n');
    assert.match(logs, /🟡 example\.com  ·  <code>dns<\/code>/);
    assert.doesNotMatch(logs, /111/);
    assert.ok(opsPosts(TOPIC.logs).every((m) => m.silent === true), 'logs are silent');
  });

  test('a failure of OURS goes to the Errors topic (loud, with details), and the person gets a plain message', async () => {
    await sleep(1200);
    buildImpl = async () => { throw new Error('boom: kaput'); };
    await say(USER, 'broken.example');
    const err = await waitFor(() => msgs(USER).find((m) => /Something went wrong/.test(text(m))), 6000, 'the error message');
    assert.match(text(err), /<b>❌ Something went wrong\.<\/b>/);
    assert.doesNotMatch(text(err), /kaput/, 'technical detail never reaches the person');
    const post = await waitFor(() => opsPosts(TOPIC.errors)[0], 6000, 'the Errors post');
    assert.match(post.text, /❗ <b>Job failed<\/b>  <code>internal<\/code>/);
    assert.match(post.text, /🌐 broken\.example/);
    assert.match(post.text, /👤 user #[0-9a-f]{4}/);
    assert.match(post.text, /<pre>boom: kaput<\/pre>/);
    assert.doesNotMatch(post.text, /111/);
    assert.equal(post.silent, false, 'errors notify');
  });

  test('Cancel stops a running job and says so', async () => {
    await sleep(1200);
    let sawAbort = false;
    buildImpl = (parsed, workDir, onStatus, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => { sawAbort = true; reject(new UserError('cancelled', 'cancelled')); });
    });
    await say(USER, 'slow.example');
    const status = await waitFor(() => msgs(USER).find((m) => m.kind === 'text' && /slow\.example/.test(text(m)) && findButton(m, /^x:/)), 5000, 'the progress message with a Cancel button');
    assert.match(buttons(status).find((b) => /^x:/.test(b.callback_data)).text, /Cancel/);
    await tap(USER, { chat: USER, id: status.id, markup: status.markup }, findButton(status, /^x:/).callback_data);
    await waitFor(() => /Cancelled/.test(text(msgs(USER).find((m) => m.id === status.id) || {})), 5000, 'the cancelled message');
    assert.equal(sawAbort, true);
    assert.deepEqual(buttons(msgs(USER).find((m) => m.id === status.id)), [], 'the Cancel button is gone');
  });

  test('if Telegram rejects the formatting, the message is resent as plain text instead of being lost', async () => {
    world.failNext('sendMessage', tgError(400, "Bad Request: can't parse entities: Unsupported start tag"));
    await say(USER, '/myid');
    const m = await waitFor(() => msgs(USER).filter((x) => /Your Telegram ID/.test(text(x))).at(-1), 3000, '/myid');
    assert.equal(m.text.includes('<b>'), false);
    assert.match(m.text, /Your Telegram ID\n111/);
  });

  test('/ping and /stats (admins) are readable and mention the archive', async () => {
    await say(ADMIN, '/ping');
    const ping = await waitFor(() => msgs(ADMIN).filter((m) => /Pong/.test(text(m))).at(-1), 4000, '/ping');
    for (const part of [/🏓 <b>Pong<\/b>/, /Resources/, /📦 Archive  live \d+  ·  vault \d+  ·  waiting \d+/, /Updates by <b>polling<\/b>/]) assert.match(text(ping), part);
    await say(ADMIN, '/stats');
    const stats = await waitFor(() => msgs(ADMIN).filter((m) => /Website Downloader<\/b>/.test(text(m))).at(-1), 4000, '/stats');
    assert.match(text(stats), /Redis <code>memory<\/code>/);
  });

  test('no link in a message gets a helpful reply; several links save the first and say so', async () => {
    await say(USER, 'hello there');
    assert.match(text(msgs(USER).at(-1)), /couldn't find a website address/);
    buildImpl = okBuild;
    await say(ADMIN, 'one.example two.example');
    await waitFor(() => msgs(ADMIN).some((m) => /I found <b>2<\/b> links|I found 2 links/.test(text(m))), 4000, 'the several-links note');
    await waitFor(() => builds.includes('https://one.example/'), 4000, 'the first link to be saved');
    assert.ok(!builds.includes('https://two.example/'));
  });

  test('every message the bot sent, anywhere, is valid Telegram HTML', () => {
    const bad = [];
    for (const [chat, c] of world.chats) {
      for (const m of c.messages.values()) {
        const t = m.text ?? m.caption;
        if (typeof t !== 'string' || m.parse === null) continue;
        const problems = htmlProblems(t);
        if (problems.length) bad.push(`${chat}: ${problems.join(', ')} in ${JSON.stringify(t).slice(0, 120)}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test.after(() => { setTimeout(() => process.exit(0), 200).unref(); });
}

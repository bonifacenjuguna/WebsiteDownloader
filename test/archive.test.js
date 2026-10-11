import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchive } from '../src/archive/service.js';
import { MemoryStore } from '../src/archive/store.js';
import { makeApi, classify } from '../src/archive/telegram.js';
import { RateLimiter } from '../src/archive/limiter.js';
import { mainCaption, partCaption, hashtag, postLink } from '../src/archive/labels.js';
import { buildDigest, TOPICS } from '../src/archive/ops.js';
import { FakeTelegram, tgError } from './helpers/fake-telegram.js';
import { htmlProblems } from './helpers/html.js';

const LIVE = -1001000000001;
const VAULT = -1001000000002;
const OPS = -1001000000003;
const DAY = 86_400_000;

// A complete little world: fake Telegram, fake clock, memory store, three spaces connected.
async function world({ live = true, vault = true, ops = true, retentionDays = 7 } = {}) {
  const clock = { t: Date.UTC(2026, 9, 10, 12, 0, 0) };
  const now = () => clock.t;
  const tg = new FakeTelegram();
  tg.clock = now;
  tg.addChat(LIVE).addChat(VAULT).addChat(OPS, { type: 'supergroup', is_forum: true });
  const limiter = new RateLimiter({ perMinute: 15, minGapMs: 1100, now, sleep: async (ms) => { clock.t += ms; } });
  const alerts = [];
  const store = new MemoryStore();
  const archive = createArchive({
    store, api: makeApi((m, p) => tg.callApi(m, p), limiter), now, secret: 'test-secret', botId: 42,
    cfg: { enabled: true, retentionMs: retentionDays * DAY, env: {}, digestEnabled: true, digestHour: 6 },
    alert: async (html) => { alerts.push(html); }, log: { warn() {} },
  });
  if (live) await archive.spaces.set('live', { chatId: LIVE, title: 'Live', kind: 'channel' });
  if (vault) await archive.spaces.set('vault', { chatId: VAULT, title: 'Vault', kind: 'channel' });
  if (ops) await archive.spaces.set('ops', { chatId: OPS, title: 'Ops', kind: 'supergroup' });
  // run the worker until nothing is due (jumping the clock to the next retry when needed)
  const pump = async (max = 60) => {
    for (let i = 0; i < max; i++) {
      const n = await archive.tick();
      const waiting = [...store.jobs.values()].filter((j) => j.state === 'pending' || j.state === 'running');
      if (!n && !waiting.length) return;
      if (!n) clock.t = Math.max(clock.t + 1000, Math.min(...waiting.map((j) => j.runAt)));
    }
  };
  const info = (over = {}) => ({
    urlKey: 'k1', host: 'example.com', title: 'Example & <Home>', url: 'https://example.com/', fileIds: ['FILE1'], fileName: 'example.com.zip',
    parts: 1, pages: 12, files: 92, bytes: 5_000_000, mode: 'site-pages', kind: 'pages', ...over,
  });
  return { clock, now, tg, store, archive, alerts, pump, info };
}
const docs = (tg, chat) => tg.messages(chat).filter((m) => m.kind === 'document');

test('a build is posted to Live: one ZIP with the full label, links stored, no user data anywhere', async () => {
  const w = await world();
  const id = await w.archive.record(w.info());
  await w.pump();
  const e = await w.store.getEntry(id);
  assert.equal(e.state, 'live');
  assert.equal(e.liveChat, LIVE);
  assert.equal(e.livePosts.length, 1);
  assert.match(e.liveLink, /^https:\/\/t\.me\/c\/1000000001\/\d+$/);
  assert.equal(e.liveExpiresAt, Date.UTC(2026, 9, 17, 12, 0, 0));
  const [post] = docs(w.tg, LIVE);
  assert.equal(post.file, 'FILE1');                    // the same Telegram file: no second upload
  assert.match(post.caption, /📦 <b>example\.com<\/b>/);
  assert.match(post.caption, /Example &amp; &lt;Home&gt;/);
  assert.match(post.caption, /📄 12 pages · 🗂 80 files · 💾 4\.8 MB/);
  assert.match(post.caption, /⏳ <i>Live until Oct 17<\/i>/);
  assert.match(post.caption, /#example_com #2026_10 #id_[0-9a-f]{6} #site/);
  assert.deepEqual(htmlProblems(post.caption), []);
  assert.ok(post.caption.length <= 1024);
  // privacy: nothing about a person exists in the entry or the post
  assert.equal(Object.keys(e).some((k) => /user|uid|chat_?id$|telegram/i.test(k) && k !== 'liveChat' && k !== 'vaultChat'), false);
  assert.doesNotMatch(JSON.stringify([e, post]), /"(user|uid|username)"/i);
});

test('with a preview: picture first, then the ZIP as a reply; the preview file is kept for reuse', async () => {
  const w = await world();
  const id = await w.archive.record(w.info({ previewBuffer: Buffer.from('jpegbytes') }));
  await w.pump();
  const msgs = w.tg.messages(LIVE);
  assert.deepEqual(msgs.map((m) => m.kind), ['photo', 'document']);
  assert.match(msgs[0].caption, /📦 <b>example\.com<\/b>/);       // the picture carries the full label
  assert.equal(msgs[1].reply, msgs[0].id);                        // the ZIP answers the picture
  assert.match(msgs[1].caption, /📦 <b>example\.com\.zip<\/b>\n💾 4\.8 MB/);
  const e = await w.store.getEntry(id);
  assert.match(e.previewFileId, /^photo-/);
  assert.deepEqual(e.livePosts.map((p) => p.kind), ['preview', 'zip']);
});

test('an existing preview file is reused, not uploaded again', async () => {
  const w = await world();
  await w.archive.record(w.info({ previewFileId: 'PREVIEW-FILE' }));
  await w.pump();
  assert.equal(w.tg.messages(LIVE)[0].file, 'PREVIEW-FILE');
});

test('several parts: the first carries the label, the rest are compact replies, in order', async () => {
  const w = await world();
  await w.archive.record(w.info({ fileIds: ['A', 'B', 'C'], parts: 3, bytes: 120_000_000 }));
  await w.pump();
  const d = docs(w.tg, LIVE);
  assert.deepEqual(d.map((m) => m.file), ['A', 'B', 'C']);
  assert.match(d[0].caption, /📚 3 parts/);
  assert.match(d[1].caption, /Part 2 of 3/);
  assert.match(d[2].caption, /Part 3 of 3/);
  assert.equal(d[1].reply, d[0].id);
  assert.equal(d[2].reply, d[0].id);
});

test('nothing is recorded until a Live space exists', async () => {
  const w = await world({ live: false });
  assert.equal(await w.archive.record(w.info()), null);
  assert.equal(w.store.entries.size, 0);
});

test('expiry: copied to the Vault first, links saved, THEN Live is cleared', async () => {
  const w = await world();
  const id = await w.archive.record(w.info({ previewFileId: 'PREV', fileIds: ['A', 'B'], parts: 2 }));
  await w.pump();
  assert.equal(w.tg.messages(LIVE).length, 3);
  w.clock.t += 8 * DAY;
  assert.equal(await w.archive.expireScan(), 1);
  await w.pump();
  const e = await w.store.getEntry(id);
  assert.equal(e.state, 'vaulted');
  assert.equal(w.tg.messages(LIVE).length, 0, 'Live is cleared');
  assert.equal(e.liveLink, null);
  assert.deepEqual(e.livePosts, []);
  const v = w.tg.messages(VAULT).filter((m) => m.kind !== 'text');
  assert.deepEqual(v.map((m) => m.kind), ['photo', 'document', 'document']);
  assert.match(v[0].caption, /🗄 <i>Archived Oct 18 from Live<\/i>/);
  assert.doesNotMatch(v[0].caption, /Live until/);
  assert.equal(v[1].reply, v[0].id);                              // the reply chain is rebuilt in the Vault
  assert.match(e.vaultLink, /^https:\/\/t\.me\/c\/1000000002\/\d+$/);
  assert.equal(e.vaultPosts.length, 3);
  // the order of the calls is the safety: every Vault copy happens before the Live delete
  const order = w.tg.calls.map((c) => c.method).filter((m) => m === 'copyMessage' || m === 'deleteMessages');
  assert.deepEqual(order, ['copyMessage', 'copyMessage', 'copyMessage', 'deleteMessages']);
});

test('expiry runs once: a second scan finds nothing, and nothing is doubled', async () => {
  const w = await world();
  await w.archive.record(w.info());
  await w.pump();
  w.clock.t += 8 * DAY;
  assert.equal(await w.archive.expireScan(), 1);
  assert.equal(await w.archive.expireScan(), 0, 'the job already waiting is not queued twice');
  await w.pump();
  assert.equal(await w.archive.expireScan(), 0);
  assert.equal(w.tg.messages(VAULT).filter((m) => m.kind === 'document').length, 1);
});

test('a failed Vault copy keeps the Live post, raises an alert, and /archive retry finishes the job', async () => {
  const w = await world();
  const id = await w.archive.record(w.info());
  await w.pump();
  w.clock.t += 8 * DAY;
  w.tg.failNext('copyMessage', tgError(403, 'Forbidden: bot is not a member of the channel chat'), { times: 99 });
  await w.archive.expireScan();
  await w.pump();
  let e = await w.store.getEntry(id);
  assert.equal(e.state, 'vault_failed');
  assert.equal(w.tg.messages(LIVE).length, 1, 'Live is untouched when the Vault copy failed');
  assert.equal(w.alerts.length, 1);
  assert.match(w.alerts[0], /could not copy to the Vault/);
  assert.deepEqual(htmlProblems(w.alerts[0]), []);
  assert.equal(await w.archive.expireScan(), 0, 'a failed item is not retried in a loop');

  w.tg.failures.length = 0;                                       // the cause is fixed
  assert.equal(await w.archive.retryFailed(), 1);
  await w.pump();
  e = await w.store.getEntry(id);
  assert.equal(e.state, 'vaulted');
  assert.equal(w.tg.messages(LIVE).length, 0);
});

test('a crash after the Vault copy but before the Live delete never duplicates the Vault copy', async () => {
  const w = await world();
  const id = await w.archive.record(w.info({ fileIds: ['A', 'B'], parts: 2 }));
  await w.pump();
  w.clock.t += 8 * DAY;
  w.tg.failNext('deleteMessages', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), { times: 1 });
  await w.archive.expireScan();
  await w.pump();
  const e = await w.store.getEntry(id);
  assert.equal(e.state, 'vaulted');
  assert.equal(w.tg.messages(VAULT).filter((m) => m.kind === 'document').length, 2, 'exactly one copy of each part');
  assert.equal(w.tg.messages(LIVE).length, 0);
  assert.equal(w.tg.calls.filter((c) => c.method === 'copyMessage').length, 2);
});

test('a Live post deleted by hand is rebuilt in the Vault from the saved files', async () => {
  const w = await world();
  const id = await w.archive.record(w.info({ previewFileId: 'PREV', fileIds: ['A'], parts: 1 }));
  await w.pump();
  const e0 = await w.store.getEntry(id);
  w.tg.deleteMsg(LIVE, e0.livePosts[0].msg);                      // the preview post disappears
  w.tg.deleteMsg(LIVE, e0.livePosts[1].msg);                      // and the ZIP post too
  w.clock.t += 8 * DAY;
  await w.archive.expireScan();
  await w.pump();
  const e = await w.store.getEntry(id);
  assert.equal(e.state, 'vaulted');
  const v = w.tg.messages(VAULT).filter((m) => m.kind !== 'text');
  assert.deepEqual(v.map((m) => [m.kind, m.file]), [['photo', 'PREV'], ['document', 'A']]);
});

test('rate limiting: never more than 15 posts a minute, never faster than 1.1 s apart, into one chat', async () => {
  const w = await world();
  for (let i = 0; i < 40; i++) await w.archive.ops.post('logs', `line ${i}`);
  await w.pump(200);
  const sends = w.tg.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === OPS && /^line /.test(c.payload.text)).map((c) => c.at);
  assert.equal(sends.length, 40);
  for (let i = 1; i < sends.length; i++) assert.ok(sends[i] - sends[i - 1] >= 1100, `gap ${sends[i] - sends[i - 1]}`);
  for (let i = 0; i < sends.length; i++) assert.ok(sends.filter((t) => t > sends[i] - 60_000 && t <= sends[i]).length <= 15, 'more than 15 in a minute');
});

test('Telegram 429: waits as told, does not count as a failure, and posts exactly once', async () => {
  const w = await world();
  const id = await w.archive.record(w.info());
  w.tg.failNext('sendDocument', tgError(429, 'Too Many Requests: retry after 7', { retry_after: 7 }));
  await w.archive.tick();
  const job = [...w.store.jobs.values()][0];
  assert.equal(job.state, 'pending');
  assert.equal(job.attempts, 0);
  assert.ok(job.runAt >= w.now() + 8000);
  assert.equal(docs(w.tg, LIVE).length, 0);
  await w.pump();
  assert.equal(docs(w.tg, LIVE).length, 1);
  assert.equal((await w.store.getEntry(id)).state, 'live');
});

test('transient errors back off and finally fail with one alert, not a flood', async () => {
  const w = await world();
  const id = await w.archive.record(w.info());
  w.tg.failNext('sendDocument', tgError(502, 'Bad Gateway'), { times: 99 });
  await w.pump(100);
  const e = await w.store.getEntry(id);
  assert.equal(e.state, 'failed');
  assert.equal(w.alerts.length, 1);
  assert.match(w.alerts[0], /could not post to Live/);
  assert.equal(w.tg.calls.filter((c) => c.method === 'sendDocument').length, 8, 'gave up after 8 attempts');
});

test('an expired file reference fails once, cleanly, and is reported', async () => {
  const w = await world();
  const id = await w.archive.record(w.info({ fileIds: ['DEAD-FILE'] }));
  await w.pump();
  assert.equal((await w.store.getEntry(id)).state, 'failed');
  assert.equal(w.tg.calls.filter((c) => c.method === 'sendDocument').length, 1, 'no pointless retries');
  assert.equal(w.alerts.length, 1);
});

test('a half-finished Live post continues where it stopped: no duplicate posts', async () => {
  const w = await world();
  const id = await w.archive.record(w.info({ fileIds: ['A', 'B', 'C'], parts: 3 }));
  w.tg.failNext('sendDocument', tgError(502, 'Bad Gateway'), { when: (p) => p.document === 'C' });
  await w.pump();
  assert.deepEqual(docs(w.tg, LIVE).map((m) => m.file), ['A', 'B', 'C']);
  assert.equal(w.tg.calls.filter((c) => c.method === 'sendDocument' && c.payload.document === 'A').length, 1);
  assert.equal((await w.store.getEntry(id)).state, 'live');
});

test('Ops: six topics are created once; posts land in the right topic with the right notification setting', async () => {
  const w = await world();
  const r = await w.archive.ops.ensureTopics();
  assert.equal(r.created.length, TOPICS.length);
  assert.deepEqual((await w.archive.ops.ensureTopics()).created, [], 'a second run creates nothing');
  assert.deepEqual(w.tg.chats.get(OPS).topics.map((t) => t.name), ['🚨 Alerts', '❗ Errors', '🚀 Deploys', '📊 Daily digest', '📜 Logs', '🛡 Admin actions']);
  await w.archive.ops.post('alerts', '🚨 <b>x</b>');
  await w.archive.ops.post('logs', 'quiet');
  await w.pump();
  const [a, l] = w.tg.messages(OPS);
  assert.equal(a.thread, w.tg.chats.get(OPS).topics[0].id);
  assert.equal(a.silent, false, 'Alerts notify');
  assert.equal(l.thread, w.tg.chats.get(OPS).topics[4].id);
  assert.equal(l.silent, true, 'Logs are silent');
});

test('Ops: a topic deleted by hand is created again and the post still arrives', async () => {
  const w = await world();
  await w.archive.ops.ensureTopics();
  w.tg.failNext('sendMessage', tgError(400, 'Bad Request: message thread not found'), { when: (p) => p.message_thread_id === w.tg.chats.get(OPS).topics[0].id });
  await w.archive.ops.post('alerts', 'still delivered');
  await w.pump();
  const delivered = w.tg.messages(OPS).find((m) => m.text === 'still delivered');
  assert.ok(delivered);
  assert.equal(w.tg.chats.get(OPS).topics.length, TOPICS.length + 1);
  assert.equal(delivered.thread, w.tg.chats.get(OPS).topics.at(-1).id);
});

test('rescue: the newest saved copy is found, and the ZIP can be copied back from the Vault or from Live', async () => {
  const w = await world();
  await w.archive.record(w.info({ fileIds: ['OLD'] }));
  await w.pump();
  w.clock.t += 2 * DAY;
  const newer = await w.archive.record(w.info({ fileIds: ['NEW'] }));
  await w.pump();
  const best = await w.archive.latestFor('k1');
  assert.equal(best.id, newer);
  assert.equal(await w.archive.latestFor('nope'), null);

  const person = -5555;
  w.tg.addChat(person, { type: 'private' });
  let entry = await w.archive.getEntry(newer);
  assert.equal(await w.archive.copyZipsTo(person, entry, () => 'from Live'), true);
  assert.equal(w.tg.messages(person)[0].file, 'NEW');
  w.clock.t += 8 * DAY;
  await w.archive.expireScan();
  await w.pump();
  entry = await w.archive.getEntry(newer);
  assert.equal(await w.archive.copyZipsTo(person, entry, (part, of) => `Part ${part}/${of}`), true);
  assert.equal(w.tg.messages(person).at(-1).copiedFrom?.startsWith(`${VAULT}:`), true, 'copied from the Vault once Live is cleared');
  assert.equal(w.tg.messages(person).at(-1).caption, 'Part 1/1');
});

test('connecting spaces: rights and kind are checked, a chat cannot hold two roles, Ops gets its topics', async () => {
  const w = await world({ live: false, vault: false, ops: false });
  w.tg.addChat(-1002, { type: 'channel', rights: { can_post_messages: true, can_edit_messages: true, can_delete_messages: false } });
  let r = await w.archive.assign('live', -1002);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['needs the right to delete']);

  w.tg.addChat(-1003, { type: 'channel' });
  assert.equal((await w.archive.assign('live', -1003)).ok, true);
  assert.match(w.tg.messages(-1003)[0].text, /<b>Connected as Live<\/b>/);
  r = await w.archive.assign('vault', -1003);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /already the Live space/);

  w.tg.addChat(-1004, { type: 'supergroup', is_forum: false });
  r = await w.archive.assign('ops', -1004);
  assert.match(r.problems[0], /Turn on Topics/);
  r = await w.archive.assign('ops', -1003);
  assert.equal(r.ok, false);

  assert.equal((await w.archive.assign('ops', OPS)).ok, true);
  assert.equal(w.tg.chats.get(OPS).topics.length, TOPICS.length);
  assert.equal((await w.archive.assign('ops', -999999)).ok, false, 'an unknown chat is a clear failure, not a crash');
});

test('the daily digest: not before its hour, once a day, valid HTML', async () => {
  const w = await world();
  const provider = async () => ({
    jobs: { ok: 18, failed: 3, cached: 7, ours: 1, p50: 22_000, p95: 61_000 },
    hosts: [{ host: 'a.com', c: 5 }], errors: [{ code: 'dns', c: 2 }],
    resources: { memMb: 310, memShare: 0.41, diskMb: 4000, sharedHits: 12, sharedMb: 40, uptime: '2d 3h' },
  });
  w.clock.t = Date.UTC(2026, 9, 10, 5, 0, 0);
  assert.equal(await w.archive.digestIfDue(provider), false);
  w.clock.t = Date.UTC(2026, 9, 10, 6, 5, 0);
  assert.equal(await w.archive.digestIfDue(provider), true);
  assert.equal(await w.archive.digestIfDue(provider), false, 'only once per day');
  w.clock.t += DAY;
  assert.equal(await w.archive.digestIfDue(provider), true);
  await w.pump();
  const posts = w.tg.messages(OPS).filter((m) => /Daily digest/.test(m.text));
  assert.equal(posts.length, 2);
  assert.deepEqual(htmlProblems(posts[0].text), []);
  assert.match(posts[0].text, /✅ <b>18<\/b> saved/);
  assert.match(posts[0].text, /Real success  <code>95%<\/code>/);
});

test('self-test passes end to end and leaves nothing behind', async () => {
  const w = await world();
  const steps = await w.archive.selfTest();
  assert.deepEqual(steps.filter((s) => !s.ok), [], JSON.stringify(steps));
  assert.equal(steps.length, 5);
  assert.equal(w.tg.messages(LIVE).length, 0);
  assert.equal(w.tg.messages(VAULT).length, 0);
  assert.equal(w.store.entries.size, 0);
  const bad = await (await world({ vault: false })).archive.selfTest();
  assert.equal(bad.filter((s) => !s.ok).length, 2, 'unset spaces are reported, not hidden');
});

test('classify: every Telegram failure becomes a decision', () => {
  const k = (e) => classify(e).kind;
  assert.equal(k(tgError(429, 'Too Many Requests', { retry_after: 3 })), 'rate');
  assert.equal(classify(tgError(429, 'x', { retry_after: 3 })).retryAfter, 3);
  assert.equal(k(tgError(400, 'Bad Request: message thread not found')), 'thread');
  assert.equal(k(tgError(400, 'Bad Request: message to copy not found')), 'gone');
  assert.equal(k(tgError(400, 'Bad Request: wrong file identifier/HTTP URL specified')), 'badfile');
  assert.equal(k(tgError(403, 'Forbidden: bot was kicked from the channel chat')), 'permanent');
  assert.equal(k(tgError(400, 'Bad Request: chat not found')), 'permanent');
  assert.equal(k(tgError(502, 'Bad Gateway')), 'transient');
  assert.equal(k(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), 'transient');
  assert.equal(k(tgError(400, 'Bad Request: something new')), 'permanent');
});

test('labels: tags are valid, long titles are cut, captions always fit Telegram and are valid HTML', () => {
  assert.equal(hashtag('Example-Site.co.ke'), '#example_site_co_ke');
  assert.equal(hashtag('www.Ünïcode.com'), '#n_code_com');
  assert.equal(hashtag('---'), '');
  assert.equal(postLink(-1001234567890, 55), 'https://t.me/c/1234567890/55');
  assert.equal(postLink(-5, 1), null);
  const e = { host: 'h.com', title: '<script>"x"</script> & '.repeat(80), url: '', tag: 'abc123', fileName: 'h.com.zip', parts: 4, pages: 3, files: 9, bytes: 1e9, mode: 'site-browser', kind: 'pages', createdAt: Date.UTC(2026, 0, 5, 3, 4), liveExpiresAt: Date.UTC(2026, 0, 12) };
  for (const c of [mainCaption(e, { place: 'live' }), mainCaption(e, { place: 'vault' }), partCaption(e, { part: 2, of: 4 }), partCaption({ ...e, parts: 1 }, { part: 1, of: 1 })]) {
    assert.ok(c.length <= 1024, `caption is ${c.length} characters`);
    assert.deepEqual(htmlProblems(c), [], c);
  }
  assert.match(mainCaption(e, { place: 'live' }), /#dynamic/);
  assert.match(mainCaption({ ...e, kind: 'listing', title: '/files/' }, { place: 'live' }), /📂 <b>h\.com<\/b>\n<code>\/files\/<\/code>[\s\S]*#files/);
});

test('the digest builder copes with missing data', () => {
  const html = buildDigest({ date: '2026-10-10', jobs: { ok: 0, failed: 0, cached: 0, ours: 0 } });
  assert.deepEqual(htmlProblems(html), []);
  assert.match(html, /Real success  <code>–<\/code>/);
});

test('the user tag is stable per person and does not reveal the id', async () => {
  const w = await world();
  const t1 = w.archive.userTag(123456789);
  assert.equal(t1, w.archive.userTag(123456789));
  assert.notEqual(t1, w.archive.userTag(123456790));
  assert.match(t1, /^user #[0-9a-f]{4}$/);
  assert.doesNotMatch(t1, /123456789/);
});

// Ops: one forum group, one topic per kind of message, so each can be muted (or not) on its own.
//   🚨 Alerts  things that need you          ❗ Errors  jobs that failed for OUR reasons
//   🚀 Deploys starts and shutdowns           📊 Daily digest  one summary a day
//   📜 Logs    quiet one-liners (muted)       🛡 Admin actions  who changed what
import crypto from 'node:crypto';
import { b, i, code, esc, ms as fmtMs, dot, table } from '../fmt.js';
import { size } from '../copy.js';

export const TOPICS = [
  { key: 'alerts', title: '🚨 Alerts', silent: false },
  { key: 'errors', title: '❗ Errors', silent: false },
  { key: 'deploys', title: '🚀 Deploys', silent: false },
  { key: 'digest', title: '📊 Daily digest', silent: true },
  { key: 'logs', title: '📜 Logs', silent: true },
  { key: 'admin', title: '🛡 Admin actions', silent: true },
];
const BY_KEY = Object.fromEntries(TOPICS.map((t) => [t.key, t]));

// "user #a3f9": enough to notice the same person twice, impossible to turn back into a Telegram id
export const makeUserTag = (secret) => (uid) => `user #${crypto.createHmac('sha256', String(secret)).update(`tag:${uid}`).digest('hex').slice(0, 4)}`;

export function createOps({ api, spaces, store, enqueue, now = () => Date.now() }) {
  let topics = null; // { chatId, threads: { key: id } }
  const load = async () => { topics ??= (await store.getSetting('ops.topics')) || { chatId: null, threads: {} }; return topics; };
  const save = () => store.setSetting('ops.topics', topics);

  async function createTopic(chat, key) {
    const t = BY_KEY[key];
    const res = await api.createForumTopic(chat, t.title);
    const state = await load();
    state.threads[key] = res.message_thread_id;
    await save();
    return res.message_thread_id;
  }

  // makes sure every topic exists in the Ops group; returns what it had to create
  async function ensureTopics() {
    const chat = await spaces.get('ops');
    if (!chat) return { created: [], existing: [], chat: null };
    const state = await load();
    if (state.chatId !== chat) { topics = { chatId: chat, threads: {} }; await save(); }
    const created = [];
    const existing = [];
    for (const t of TOPICS) {
      if (topics.threads[t.key]) { existing.push(t.key); continue; }
      await createTopic(chat, t.key);
      created.push(t.key);
    }
    return { created, existing, chat };
  }

  async function threadFor(key) {
    const chat = await spaces.get('ops');
    if (!chat) return null;
    const state = await load();
    if (state.chatId !== chat || !state.threads[key]) await ensureTopics();
    return { chat, thread: topics.threads[key] };
  }

  // sends now (the outbox calls this). A topic deleted by hand is created again and the post goes through.
  async function send(key, html) {
    const target = await threadFor(key);
    if (!target) return false;
    const extra = { message_thread_id: target.thread, disable_notification: BY_KEY[key].silent };
    try {
      await api.sendMessage(target.chat, html.slice(0, 4000), extra);
    } catch (e) {
      if (e.kind !== 'thread') throw e;
      const thread = await createTopic(target.chat, key);
      await api.sendMessage(target.chat, html.slice(0, 4000), { ...extra, message_thread_id: thread });
    }
    return true;
  }

  // queues a post: durable, rate-limited, never blocks the caller
  const post = async (key, html) => {
    if (!(await spaces.get('ops'))) return false;
    try { await enqueue({ kind: 'ops_post', role: 'ops', payload: { key, html }, runAt: now() }); return true; }
    catch (e) { console.warn('[ops] could not queue a post:', e?.message); return false; }
  };

  return { ensureTopics, send, post, threadFor, topics: () => TOPICS };
}

// ---------------------------------------------------------------- the daily digest (pure: data in, HTML out)
const pct = (x, y) => (Number(y) ? Math.round((Number(x) / Number(y)) * 100) : null);
const pctText = (v) => (v == null ? '–' : `${v}%`);

export function buildDigest(d) {
  const j = d.jobs;
  const real = j.ok + j.ours ? Math.round((j.ok / (j.ok + j.ours)) * 100) : null;
  const lines = [
    `📊 ${b('Daily digest')}  ${i(d.date)}`,
    '',
    b('Last 24 hours'),
    `✅ ${b(j.ok)} saved  ·  ❌ ${b(j.failed)} failed  ·  ⚡ ${b(j.cached)} from cache`,
    `${dot(real, 90, 75, true)} Real success  ${code(pctText(real))}  ${i('without typos, private addresses and protected sites')}`,
    ...(j.p50 != null ? [`⏱ Build time  median ${code(fmtMs(j.p50))}  ·  95% under ${code(fmtMs(j.p95))}`] : []),
  ];
  if (d.hosts?.length) lines.push('', b('Top sites'), ...d.hosts.map((h, n) => `${n + 1}. ${esc(h.host)}  ·  ${code(h.c)}`));
  if (d.errors?.length) lines.push('', b('Top failures'), ...d.errors.map((e) => `• ${esc(e.code)}  ·  ${code(e.c)}`));
  if (d.archive) {
    const a = d.archive;
    lines.push('', b('Archive'),
      `📡 Live ${code(a.live)}  ·  🗄 Vault ${code(a.vaulted)}  ·  ⏳ Waiting ${code(a.waiting)}`,
      ...(a.problems ? [`⚠️ ${b(a.problems)} item${a.problems === 1 ? '' : 's'} need attention  ${i('/archive retry')}`] : []));
  }
  if (d.resources) {
    const r = d.resources;
    lines.push('', b('Resources'),
      table([
        ['memory', `${r.memMb} MB${r.memShare == null ? '' : ` (${Math.round(r.memShare * 100)}% of container)`}`],
        ['disk free', r.diskMb == null ? '?' : `${r.diskMb} MB`],
        ['shared cache', r.sharedHits == null ? 'off' : `${r.sharedHits} hits · ${r.sharedMb} MB`],
        ['uptime', r.uptime],
      ]));
  }
  return lines.join('\n');
}

export const fileSize = size;

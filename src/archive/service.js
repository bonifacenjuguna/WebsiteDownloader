// The archive: every successful build is copied (never uploaded twice) to the private Live channel, copied on to the
// Vault just before Live is cleared, and can be handed back when the original site is gone.
//
//   build delivered ──▶ record() ──▶ outbox: live_post ──▶ Live (preview? + ZIP parts, labelled)
//   LIVE_RETENTION_HOURS later ──▶ outbox: vault_copy ──▶ Vault (copy) ──▶ Live posts deleted ──▶ entry = vaulted
//   site dead ──▶ rescue: the latest entry's ZIP is sent back to the person
//
// Everything that talks to Telegram goes through the outbox: it survives restarts, retries with backoff, respects 429,
// and never delays or breaks a user's download. Nothing here knows who asked for a site.
import crypto from 'node:crypto';
import { b, i, code, esc } from '../fmt.js';
import { createSpaces, ROLES, ROLE_INFO, kindProblem, missingRights } from './spaces.js';
import { createOps, makeUserTag, buildDigest } from './ops.js';
import { mainCaption, partCaption, postLink } from './labels.js';
import { classify, TgError } from './telegram.js';

const MAX_ATTEMPTS = 8;
const LOCK_MS = 5 * 60_000;
const backoff = (n) => Math.min(30 * 60_000, 30_000 * 2 ** (n - 1));
const HOUR = 60 * 60_000;

export function createArchive({ store, api, cfg, now = () => Date.now(), alert = async () => {}, secret = 'archive', botId = 0, log = console }) {
  const botIdOf = typeof botId === "function" ? botId : () => botId;
  const spaces = createSpaces({ store, env: cfg.env || {} });
  const enqueue = (job) => store.enqueue({ runAt: now(), ...job });
  const ops = createOps({ api, spaces, store, enqueue, now });
  const userTag = makeUserTag(secret);
  const alerted = new Map();
  const alertLimited = async (key, html, everyMs = HOUR) => {
    if (now() - (alerted.get(key) || 0) < everyMs) return;
    alerted.set(key, now());
    await alert(html);
  };
  let snapshot = { live: 0, vaulted: 0, waiting: 0, problems: 0 };

  // ------------------------------------------------------------ recording
  // Called right after a build is delivered. Only queues work, so it is fast and cannot fail the user's download.
  async function record(info) {
    if (!cfg.enabled) return null;
    try {
      if (!(await spaces.get('live'))) return null;
      const id = await store.insertEntry({
        urlKey: info.urlKey, host: info.host, title: info.title || '', url: info.url || '', tag: crypto.randomBytes(3).toString('hex'),
        fileIds: info.fileIds, fileName: info.fileName, parts: info.parts, pages: info.pages || 0, files: info.files || 0,
        bytes: info.bytes || 0, mode: info.mode, kind: info.kind, previewFileId: info.previewFileId || null, state: 'pending', createdAt: now(),
      });
      await enqueue({
        kind: 'live_post', role: 'live', dedupe: `live:${id}`,
        payload: { entryId: id, previewB64: info.previewBuffer?.length ? info.previewBuffer.toString('base64') : null },
      });
      return id;
    } catch (e) {
      log.warn?.('[archive] could not record:', e?.message);
      return null;
    }
  }

  // ------------------------------------------------------------ job: post one item to Live
  // Resumable: each post is saved the moment it exists, so a retry continues instead of posting twice.
  async function doLivePost(job) {
    const e = await store.getEntry(job.payload.entryId);
    if (!e || ['live', 'vaulting', 'vaulted'].includes(e.state)) return;
    const chat = await spaces.get('live');
    if (!chat) throw new TgError('the Live space is not set', { kind: 'permanent' });
    const expiresAt = e.liveExpiresAt ?? now() + cfg.retentionMs;
    const forCaption = { ...e, liveExpiresAt: expiresAt };
    const posts = [...e.livePosts];
    const has = (kind, part) => posts.some((p) => p.kind === kind && p.part === part);
    const save = (extra = {}) => store.updateEntry(e.id, { livePosts: posts, liveChat: chat, liveExpiresAt: expiresAt, ...extra });
    const buf = job.payload.previewB64 ? Buffer.from(job.payload.previewB64, 'base64') : null;
    let previewId = e.previewFileId;
    const withPreview = !!(previewId || buf || has('preview', 0));
    let first = posts[0]?.msg ?? null;

    if (withPreview && !has('preview', 0) && (previewId || buf)) {
      const res = await api.sendPhoto(chat, previewId || { source: buf, filename: 'preview.jpg' }, mainCaption(forCaption, { place: 'live' }));
      posts.push({ kind: 'preview', part: 0, msg: res.message_id });
      first = res.message_id;
      previewId = previewId || res.photo?.at?.(-1)?.file_id || null; // reusable: later copies need no new upload
      await save({ previewFileId: previewId });
    }
    const hasPreview = posts.some((p) => p.kind === 'preview');
    for (let n = 0; n < e.fileIds.length; n++) {
      const part = n + 1;
      if (has('zip', part)) continue;
      const full = !hasPreview && n === 0; // no preview: the first ZIP carries the full label
      const caption = full ? mainCaption(forCaption, { place: 'live' }) : partCaption(e, { part, of: e.fileIds.length });
      const extra = first && !full ? { reply_parameters: { message_id: first, allow_sending_without_reply: true } } : {};
      const res = await api.sendDocument(chat, e.fileIds[n], caption, extra);
      posts.push({ kind: 'zip', part, msg: res.message_id });
      first ??= res.message_id;
      await save();
    }
    await store.updateEntry(e.id, {
      livePosts: posts, liveChat: chat, liveLink: postLink(chat, posts[0]?.msg), liveExpiresAt: expiresAt, state: 'live', error: null,
    });
  }

  // ------------------------------------------------------------ job: Live -> Vault, then clear Live
  // The order is the safety: the Vault copy and its links are saved BEFORE anything is deleted from Live.
  async function doVaultCopy(job) {
    const e = await store.getEntry(job.payload.entryId);
    if (!e || e.state === 'vaulted' || !['live', 'vaulting', 'vault_failed'].includes(e.state)) return;
    const vault = await spaces.get('vault');
    if (!vault) throw new TgError('the Vault space is not set', { kind: 'permanent' });
    const liveChat = e.liveChat ?? (await spaces.get('live'));
    const vaultedAt = e.vaultedAt ?? now();
    const forCaption = { ...e, vaultedAt };
    await store.updateEntry(e.id, { state: 'vaulting', vaultedAt });
    const vposts = [...e.vaultPosts];
    const have = (kind, part) => vposts.some((p) => p.kind === kind && p.part === part);
    let first = vposts[0]?.msg ?? null;

    for (const lp of e.livePosts) {
      if (have(lp.kind, lp.part)) continue;
      if (lp.kind === 'preview' && !e.previewFileId && !liveChat) continue;
      const full = lp.kind === 'preview' || (lp.part === 1 && !vposts.some((p) => p.kind === 'preview'));
      const caption = full ? mainCaption(forCaption, { place: 'vault' }) : partCaption(e, { part: lp.part, of: e.fileIds.length });
      const extra = first && !full ? { reply_parameters: { message_id: first, allow_sending_without_reply: true } } : {};
      let res;
      try {
        res = await api.copyMessage(vault, liveChat, lp.msg, { caption, ...extra });
      } catch (err) {
        if (err.kind !== 'gone') throw err;
        // someone deleted the Live post by hand: rebuild it in the Vault from the files we still hold
        if (lp.kind === 'preview') {
          if (!e.previewFileId) continue;
          res = await api.sendPhoto(vault, e.previewFileId, caption, extra);
        } else {
          res = await api.sendDocument(vault, e.fileIds[lp.part - 1], caption, extra);
        }
      }
      vposts.push({ kind: lp.kind, part: lp.part, msg: res.message_id });
      first ??= res.message_id;
      await store.updateEntry(e.id, { vaultPosts: vposts, vaultChat: vault });
    }
    await store.updateEntry(e.id, { vaultPosts: vposts, vaultChat: vault, vaultLink: postLink(vault, vposts[0]?.msg), vaultedAt });
    const ids = e.livePosts.map((p) => p.msg);
    if (ids.length) {
      try { await api.deleteMessages(liveChat, ids); } catch (err) { if (err.kind !== 'gone') throw err; }
    }
    await store.updateEntry(e.id, { livePosts: [], liveLink: null, state: 'vaulted', error: null });
    await ops.post('logs', `🗄 ${esc(e.host)}  ${i('moved to the Vault')}  ${code(`#id_${e.tag}`)}`);
  }

  async function doOpsPost(job) { await ops.send(job.payload.key, job.payload.html); }

  // ------------------------------------------------------------ the worker
  async function onFailed(job, err) {
    const entry = job.payload?.entryId ? await store.getEntry(job.payload.entryId) : null;
    const what = entry ? `${esc(entry.host)} ${code(`#id_${entry.tag}`)}` : '';
    if (job.kind === 'live_post') {
      if (entry) await store.updateEntry(entry.id, { state: 'failed', error: err.message.slice(0, 300) });
      await alertLimited(`live:${err.kind}:${err.message}`, `⚠️ ${b('Archive: could not post to Live')}\n${what}\n${i(esc(err.message.slice(0, 200)))}\n${i('Fix the cause, then /archive retry')}`);
    } else if (job.kind === 'vault_copy') {
      if (entry) await store.updateEntry(entry.id, { state: 'vault_failed', error: err.message.slice(0, 300) });
      await alertLimited(`vault:${err.kind}:${err.message}`, `⚠️ ${b('Archive: could not copy to the Vault')}\n${what}\n${i(esc(err.message.slice(0, 200)))}\n${i('The post stays in Live. Fix the cause, then /archive retry')}`);
    } else {
      log.warn?.('[archive] dropped an Ops post:', err.message);
    }
  }

  async function runJob(job) {
    try {
      if (job.kind === 'live_post') await doLivePost(job);
      else if (job.kind === 'vault_copy') await doVaultCopy(job);
      else if (job.kind === 'ops_post') await doOpsPost(job);
      else throw new TgError(`unknown job kind ${job.kind}`, { kind: 'permanent' });
      await store.deleteJob(job.id);
    } catch (raw) {
      const err = classify(raw);
      const attempts = job.attempts + 1;
      if (err.kind === 'rate') { // Telegram said "wait N seconds": wait, and do not count it as a failure
        await store.updateJob(job.id, { state: 'pending', runAt: now() + (err.retryAfter + 1) * 1000, lastError: err.message });
        return;
      }
      if ((err.kind === 'transient' || err.kind === 'thread') && attempts < MAX_ATTEMPTS) {
        await store.updateJob(job.id, { state: 'pending', attempts, runAt: now() + backoff(attempts), lastError: err.message });
        return;
      }
      await store.updateJob(job.id, { state: 'failed', attempts, lastError: `${err.kind}: ${err.message}`.slice(0, 500) });
      await onFailed(job, err);
    }
  }

  async function tick() {
    const jobs = await store.claimDue(now(), 5, LOCK_MS);
    for (const job of jobs) await runJob(job);
    return jobs.length;
  }

  // ------------------------------------------------------------ scheduled work
  // Items past their Live time go to the Vault. Also repairs anything left half-way by a crash.
  async function expireScan() {
    let queued = 0;
    for (const e of await store.dueExpiries(now(), 50))
      if (await enqueue({ kind: 'vault_copy', role: 'live', payload: { entryId: e.id }, dedupe: `vault:${e.id}` })) queued++;
    const grace = now() - 30 * 60_000;
    for (const e of await store.stalePending(grace, 50)) await enqueue({ kind: 'live_post', role: 'live', payload: { entryId: e.id }, dedupe: `live:${e.id}` });
    for (const e of await store.staleVaulting(grace, 50)) await enqueue({ kind: 'vault_copy', role: 'live', payload: { entryId: e.id }, dedupe: `vault:${e.id}` });
    await store.pruneFailed(now() - 30 * 24 * HOUR);
    return queued;
  }

  async function retryFailed() {
    for (const j of await store.failedJobs(200)) {
      if (j.kind === 'live_post') await store.updateEntry(j.payload.entryId, { state: 'pending', error: null });
      if (j.kind === 'vault_copy') await store.updateEntry(j.payload.entryId, { state: 'vaulting', error: null });
    }
    return store.retryFailed(now());
  }

  async function refreshSnapshot() {
    const c = await store.counts();
    const e = c.entries;
    const j = c.jobs;
    snapshot = {
      live: e.live || 0, vaulted: e.vaulted || 0,
      waiting: (e.pending || 0) + (e.vaulting || 0) + (j.pending || 0) + (j.running || 0),
      problems: (e.failed || 0) + (e.vault_failed || 0) + (j.failed || 0),
    };
    return snapshot;
  }

  // one digest a day, after DIGEST_HOUR_UTC. The day is claimed first, so two instances never both post it.
  async function digestIfDue(provider) {
    if (!cfg.digestEnabled || !(await spaces.get('ops'))) return false;
    const d = new Date(now());
    if (d.getUTCHours() < cfg.digestHour) return false;
    const day = d.toISOString().slice(0, 10);
    if ((await store.getSetting('digest.last')) === day) return false;
    await store.setSetting('digest.last', day);
    const data = await provider();
    await ops.post('digest', buildDigest({ date: day, archive: await refreshSnapshot(), ...data }));
    return true;
  }

  let timers = [];
  let started = false;
  function start({ digestProvider } = {}) {
    if (started) return; // the worker also carries the Ops posts, so it runs even when ARCHIVE=false (that switch only stops new Live/Vault records)
    started = true;
    const every = (fn, ms, first) => {
      const run = () => fn().catch((e) => log.warn?.(`[archive] ${fn.name || 'task'} failed:`, e?.message));
      const t = setInterval(run, ms);
      t.unref?.();
      const f = setTimeout(run, first);
      f.unref?.();
      timers.push(t, f);
    };
    const loop = async () => {
      let wait = 1500;
      try { if (await tick()) wait = 100; } catch (e) { log.warn?.('[archive] worker:', e?.message); wait = 10_000; }
      if (started) { const t = setTimeout(loop, wait); t.unref?.(); timers.push(t); if (timers.length > 50) timers = timers.slice(-20); }
    };
    loop();
    every(expireScan, 5 * 60_000, 30_000);
    every(refreshSnapshot, 60_000, 5_000);
    if (digestProvider) every(() => digestIfDue(digestProvider), 10 * 60_000, 60_000);
  }
  function stop() { started = false; for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; }

  // ------------------------------------------------------------ rescue: hand a saved copy back
  const latestFor = (urlKey) => store.latestForKey(urlKey);
  const getEntry = (id) => store.getEntry(id);
  // the ZIP posts still in a channel, copied straight to a chat (used when a file reference has expired)
  async function copyZipsTo(chat, entry, captionOf) {
    const src = entry.vaultPosts.some((p) => p.kind === 'zip') ? { chat: entry.vaultChat, posts: entry.vaultPosts } : { chat: entry.liveChat, posts: entry.livePosts };
    const zips = src.posts.filter((p) => p.kind === 'zip');
    if (!src.chat || !zips.length) return false;
    for (const p of zips) await api.copyMessage(chat, src.chat, p.msg, { caption: captionOf(p.part, zips.length), disable_notification: false });
    return true;
  }

  // ------------------------------------------------------------ connecting spaces
  async function inspect(chatId) {
    const chat = await api.getChat(chatId);
    const member = await api.getChatMember(chatId, botIdOf());
    const fits = {};
    for (const r of ROLES) fits[r] = [kindProblem(r, chat), ...missingRights(r, member, chat).map((m) => `needs the right to ${m}`)].filter(Boolean);
    return { chat, member, fits };
  }

  async function assign(role, chatId) {
    try {
      const { chat, fits } = await inspect(chatId);
      if (fits[role].length) return { ok: false, problems: fits[role] };
      const other = await spaces.roleOf(chat.id);
      if (other && other !== role) return { ok: false, problems: [`this chat is already the ${ROLE_INFO[other].name} space`] };
      await spaces.set(role, { chatId: chat.id, title: chat.title || String(chat.id), kind: chat.type });
      let topics = null;
      if (role === 'ops') {
        topics = await ops.ensureTopics();
        await ops.post('deploys', `✅ ${b('Ops connected')}\n${i('Alerts, errors, deploys, the daily digest, logs and admin actions will appear in their own topics.')}`);
      } else {
        await api.sendMessage(chat.id, `${ROLE_INFO[role].icon} ${b(`Connected as ${ROLE_INFO[role].name}`)}\n${i(ROLE_INFO[role].what)}`, { disable_notification: true });
      }
      return { ok: true, title: chat.title, topics };
    } catch (e) {
      return { ok: false, problems: [classify(e).message] };
    }
  }

  // ------------------------------------------------------------ self-test: proves it all works in YOUR environment
  async function selfTest() {
    const steps = [];
    const step = async (name, fn) => {
      try { steps.push({ name, ok: true, detail: (await fn()) || '' }); }
      catch (e) { steps.push({ name, ok: false, detail: String(e?.message || e).slice(0, 180) }); }
    };
    await step('Database: write, claim, retry guard, clean up', async () => {
      const id = await store.insertEntry({ urlKey: 'selftest', host: 'selftest.local', title: '', url: '', tag: 'test00', fileIds: [], fileName: '', parts: 1, pages: 0, files: 0, bytes: 0, mode: 'test', kind: 'pages', previewFileId: null, state: 'test', createdAt: now() });
      try {
        await store.updateEntry(id, { state: 'test2', livePosts: [{ kind: 'zip', part: 1, msg: 1 }], liveExpiresAt: now() + 1000 });
        const back = await store.getEntry(id);
        if (back?.state !== 'test2' || back.livePosts[0]?.msg !== 1 || !back.liveExpiresAt) throw new Error('an updated entry did not read back correctly');
        const key = `selftest:${id}`;
        const a = await store.enqueue({ kind: 'selftest', role: 'live', payload: { id }, runAt: now(), dedupe: key });
        const dup = await store.enqueue({ kind: 'selftest', role: 'live', payload: { id }, runAt: now(), dedupe: key });
        if (!a || dup) throw new Error('duplicate jobs are not being refused');
        const claimed = (await store.claimDue(now(), 50, 1000)).filter((j) => j.kind === 'selftest');
        if (claimed.length !== 1) throw new Error(`expected to claim 1 job, got ${claimed.length}`);
        await store.deleteJob(claimed[0].id);
        await store.setSetting('selftest', { ok: true });
        if (!(await store.getSetting('selftest'))?.ok) throw new Error('a setting did not read back');
      } finally { await store.deleteEntry(id); }
      return store.durable ? 'Postgres' : 'memory only (nothing survives a restart)';
    });
    const sent = [];
    const probe = async (chat) => { const m = await api.sendMessage(chat, `🧪 ${b('Self-test')} ${i('(deleted right away)')}`, { disable_notification: true }); sent.push([chat, m.message_id]); return m.message_id; };
    const live = await spaces.get('live');
    const vault = await spaces.get('vault');
    await step('Live: post and delete', async () => {
      if (!live) throw new Error('not connected: send /archive setup');
      const id = await probe(live);
      await api.deleteMessages(live, [id]);
      sent.pop();
    });
    await step('Vault: post and delete', async () => {
      if (!vault) throw new Error('not connected: send /archive setup');
      const id = await probe(vault);
      await api.deleteMessages(vault, [id]);
      sent.pop();
    });
    await step('Live → Vault: copy, then clear Live', async () => {
      if (!live || !vault) throw new Error('needs both Live and Vault: send /archive setup');
      const id = await probe(live);
      const copy = await api.copyMessage(vault, live, id, { caption: undefined });
      await api.deleteMessages(live, [id]);
      await api.deleteMessages(vault, [copy.message_id]);
      sent.length = 0;
    });
    await step('Ops: topics and a post', async () => {
      if (!(await spaces.get('ops'))) throw new Error('not connected: send /archive setup');
      const r = await ops.ensureTopics();
      await ops.send('logs', `🧪 ${b('Self-test')} ${i('Ops can post')}`);
      return r.created.length ? `created ${r.created.length} topic${r.created.length === 1 ? '' : 's'}` : 'all topics present';
    });
    for (const [chat, id] of sent) await api.deleteMessages(chat, [id]).catch(() => {}); // leave nothing behind
    return steps;
  }

  return {
    spaces, ops, userTag, record, tick, expireScan, retryFailed, refreshSnapshot, digestIfDue, start, stop,
    latestFor, getEntry, copyZipsTo, inspect, assign, selfTest,
    search: (term, limit = 5) => store.searchHost(term, limit),
    counts: () => store.counts(),
    snapshot: () => snapshot,
    describe: () => spaces.all(),
    enabled: cfg.enabled,
  };
}

// Resume after a restart. Every running job is written to Redis; when the bot starts and finds jobs that never finished
// (a deploy or crash cut them off), it picks them up again instead of leaving people waiting on a dead progress message.
// Needs Redis; without it the registry lives in memory and a restart simply starts clean.
import { CFG } from './config.js';
import { jobs } from './store.js';

export const MAX_ATTEMPTS = 2;

export const register = (id, rec) => (CFG.resume ? jobs.add(id, rec) : Promise.resolve());
export const finish = (id) => (CFG.resume ? jobs.remove(id) : Promise.resolve());

// jobs that were running when the previous process stopped
export async function unfinished() {
  if (!CFG.resume) return [];
  const out = [];
  for (const j of await jobs.all()) {
    if (Date.now() - j.startedAt > CFG.resumeMaxAgeMs || (j.attempts || 0) >= MAX_ATTEMPTS) { out.push({ ...j, expired: true }); continue; }
    out.push(j);
  }
  return out;
}

// the minimal slice of a Telegraf context the pipeline uses, built from just a chat id (used for resumed jobs)
export function makeContext(telegram, rec) {
  const chatId = rec.chatId;
  return {
    telegram,
    chat: { id: chatId, type: 'private' },
    from: { id: rec.uid, language_code: rec.lang },
    reply: (text, extra) => telegram.sendMessage(chatId, text, extra),
    replyWithDocument: (doc, extra) => telegram.sendDocument(chatId, doc, extra),
    replyWithPhoto: (photo, extra) => telegram.sendPhoto(chatId, photo, extra),
    sendChatAction: (a) => telegram.sendChatAction(chatId, a),
    answerCbQuery: async () => {},
  };
}

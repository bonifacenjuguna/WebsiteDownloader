// A thin, typed layer over the Telegram Bot API for the archive. Every failure becomes a TgError with a `kind`,
// so the outbox can decide: wait and retry (rate), retry later (transient), repair (thread / badfile) or give up (permanent, gone).
export class TgError extends Error {
  constructor(message, { kind, retryAfter = 0, code = 0 } = {}) {
    super(message);
    this.name = 'TgError';
    this.kind = kind;
    this.retryAfter = retryAfter;
    this.code = code;
  }
}

const NETWORK = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network|fetch failed|timeout/i;

export function classify(err) {
  if (err instanceof TgError) return err;
  const code = Number(err?.response?.error_code ?? err?.code ?? 0);
  const text = String(err?.response?.description ?? err?.description ?? err?.message ?? err);
  const retryAfter = Number(err?.response?.parameters?.retry_after ?? err?.parameters?.retry_after ?? 0);
  const mk = (kind) => new TgError(text, { kind, retryAfter, code });
  if (code === 429 || retryAfter) return mk('rate');
  if (/message thread not found|TOPIC_ID_INVALID|TOPIC_DELETED|thread not found/i.test(text)) return mk('thread');
  if (/message to (copy|delete|forward|reply)[^ ]* not found|message can't be (copied|deleted)|MESSAGE_ID_INVALID|message identifier is not specified/i.test(text)) return mk('gone');
  if (/wrong file identifier|FILE_REFERENCE|wrong remote file|FILE_ID_INVALID|failed to get HTTP URL content/i.test(text)) return mk('badfile');
  if (code === 403 || /chat not found|bot was kicked|bot is not a member|not enough rights|have no rights|CHAT_ADMIN_REQUIRED|need administrator rights|CHAT_WRITE_FORBIDDEN|bot was blocked/i.test(text)) return mk('permanent');
  if (code >= 500 || NETWORK.test(`${err?.code} ${text}`) || err?.name === 'AbortError' || err?.name === 'TimeoutError') return mk('transient');
  if (code === 400) return mk('permanent');
  return mk('transient'); // unknown (a bug or a new error): retry a few times, then it is reported
}

// `callApi(method, payload)` is Telegraf's; `limiter.take(chatId)` spaces sends so a channel is never flooded.
export function makeApi(callApi, limiter = null) {
  const call = async (method, payload, chat) => {
    if (limiter && chat != null) await limiter.take(chat);
    try { return await callApi(method, payload); } catch (e) { throw classify(e); }
  };
  const HTML = { parse_mode: 'HTML' };
  const QUIET = { disable_notification: true };
  return {
    sendMessage: (chat, text, extra = {}) => call('sendMessage', { chat_id: chat, text, ...HTML, link_preview_options: { is_disabled: true }, ...extra }, chat),
    sendPhoto: (chat, photo, caption, extra = {}) => call('sendPhoto', { chat_id: chat, photo, caption, ...HTML, ...QUIET, ...extra }, chat),
    sendDocument: (chat, document, caption, extra = {}) => call('sendDocument', { chat_id: chat, document, caption, ...HTML, ...QUIET, ...extra }, chat),
    copyMessage: (chat, from, messageId, extra = {}) => call('copyMessage', { chat_id: chat, from_chat_id: from, message_id: messageId, ...HTML, ...QUIET, ...extra }, chat),
    deleteMessages: (chat, ids) => call('deleteMessages', { chat_id: chat, message_ids: ids }, chat),
    createForumTopic: (chat, name) => call('createForumTopic', { chat_id: chat, name }, chat),
    getChatMember: (chat, userId) => call('getChatMember', { chat_id: chat, user_id: userId }, null),
    getChat: (chat) => call('getChat', { chat_id: chat }, null),
  };
}

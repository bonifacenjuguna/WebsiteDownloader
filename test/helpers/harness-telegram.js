import { FakeTelegram, tgError } from './fake-telegram.js';

// The fake Telegram plus the handful of methods the bot itself uses (editing, deleting, menus, getMe).
export class HarnessTelegram extends FakeTelegram {
  constructor() { super(); this.menus = new Map(); this.me = { id: 42, username: 'testbot' }; this.fileSeq = 0; }

  async callApi(method, p) {
    switch (method) {
      case 'getMe': return this.me;
      case 'deleteWebhook': case 'setWebhook': case 'sendChatAction': case 'answerCallbackQuery': return true;
      case 'getWebhookInfo': return { url: '' };
      case 'setMyCommands': this.menus.set(`${p.scope?.type}|${p.language_code || ''}|${p.scope?.chat_id || ''}`, p.commands); this.calls.push({ method, payload: p, at: this.clock() }); return true;
      case 'getMyCommands': return this.menus.get(`${p.scope?.type}|${p.language_code || ''}|${p.scope?.chat_id || ''}`) || [];
      case 'deleteMyCommands': this.menus.delete(`${p.scope?.type}|${p.language_code || ''}|${p.scope?.chat_id || ''}`); return true;
      case 'editMessageText': {
        this.calls.push({ method, payload: p, at: this.clock() });
        const m = this.chats.get(p.chat_id)?.messages.get(p.message_id);
        if (!m) throw tgError(400, 'Bad Request: message to edit not found');
        Object.assign(m, { text: p.text, markup: p.reply_markup ?? null, parse: p.parse_mode ?? m.parse });
        return m;
      }
      case 'deleteMessage': {
        this.calls.push({ method, payload: p, at: this.clock() });
        this.chats.get(p.chat_id)?.messages.delete(p.message_id);
        return true;
      }
      case 'sendDocument': {
        const res = await super.callApi(method, p);
        const fileId = typeof p.document === 'string' ? p.document : `FID-${++this.fileSeq}`; // an upload gets a new file id, like the real thing
        this.chats.get(p.chat_id).messages.get(res.message_id).file = fileId;
        return { ...res, document: { file_id: fileId } };
      }
      default: return super.callApi(method, p);
    }
  }
}

// Telegraf's own Telegram client: methods that call this.callApi (which the bot patches on the prototype)
export function makeTelegramClass(world) {
  return class Telegram {
    callApi(method, payload) { return world.callApi(method, payload); }
    sendMessage(chat, text, extra = {}) { return this.callApi('sendMessage', { chat_id: chat, text, ...extra }); }
    sendDocument(chat, document, extra = {}) { return this.callApi('sendDocument', { chat_id: chat, document: document?.source ? { source: document.source, filename: document.filename } : document, ...extra }); }
    sendPhoto(chat, photo, extra = {}) { return this.callApi('sendPhoto', { chat_id: chat, photo, ...extra }); }
    editMessageText(chat, id, _inline, text, extra = {}) { return this.callApi('editMessageText', { chat_id: chat, message_id: id, text, ...extra }); }
    deleteMessage(chat, id) { return this.callApi('deleteMessage', { chat_id: chat, message_id: id }); }
    getMe() { return this.callApi('getMe', {}); }
    deleteWebhook(extra) { return this.callApi('deleteWebhook', extra); }
    setWebhook(url, extra) { return this.callApi('setWebhook', { url, ...extra }); }
    setMyCommands(commands, extra = {}) { return this.callApi('setMyCommands', { commands, ...extra }); }
  };
}

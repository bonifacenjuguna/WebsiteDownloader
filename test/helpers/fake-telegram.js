// A small Telegram that behaves like the real one where the archive cares: message ids per chat, copy and delete,
// forum topics, rights, and failures on demand (429, kicked, missing posts, network).
export const tgError = (code, description, parameters) => Object.assign(new Error(`${code}: ${description}`), { response: { error_code: code, description, parameters } });

export class FakeTelegram {
  constructor() {
    this.chats = new Map();     // id -> { type, title, is_forum, rights, messages: Map, seq, topics: [] }
    this.calls = [];            // every API call, in order
    this.failures = [];         // [{ method, when?(payload), error, times }]
    this.clock = () => Date.now();
    this.topicSeq = 100;
  }

  addChat(id, { type = 'channel', title = `chat ${id}`, is_forum = false, rights = 'all' } = {}) {
    this.chats.set(id, { type, title, is_forum, rights, messages: new Map(), seq: 0, topics: [] });
    return this;
  }
  failNext(method, error, { when = () => true, times = 1 } = {}) { this.failures.push({ method, error, when, times }); }
  messages(chat) { return [...this.chats.get(chat).messages.values()]; }
  deleteMsg(chat, id) { this.chats.get(chat).messages.delete(id); }

  #chat(id) {
    const c = this.chats.get(id);
    if (!c) throw tgError(400, 'Bad Request: chat not found');
    return c;
  }
  #add(chat, msg) {
    const c = this.#chat(chat);
    const id = ++c.seq;
    c.messages.set(id, { id, chat, at: this.clock(), ...msg });
    return id;
  }

  async callApi(method, p) {
    this.calls.push({ method, payload: p, at: this.clock() });
    const f = this.failures.find((x) => x.method === method && x.times > 0 && x.when(p));
    if (f) { f.times--; throw f.error; }
    switch (method) {
      case 'sendMessage': return { message_id: this.#add(p.chat_id, { kind: 'text', text: p.text, thread: p.message_thread_id ?? null, silent: !!p.disable_notification, markup: p.reply_markup ?? null, parse: p.parse_mode ?? null }) };
      case 'sendPhoto': {
        const id = this.#add(p.chat_id, { kind: 'photo', caption: p.caption, markup: p.reply_markup ?? null, reply: p.reply_parameters?.message_id ?? null, file: typeof p.photo === 'string' ? p.photo : 'new-photo-file' });
        return { message_id: id, photo: [{ file_id: 'small' }, { file_id: `photo-${p.chat_id}-${id}` }] };
      }
      case 'sendDocument': {
        if (typeof p.document === 'string' && p.document.startsWith('DEAD')) throw tgError(400, 'Bad Request: wrong file identifier/HTTP URL specified');
        return { message_id: this.#add(p.chat_id, { kind: 'document', caption: p.caption, markup: p.reply_markup ?? null, parse: p.parse_mode ?? null, reply: p.reply_parameters?.message_id ?? null, file: p.document }) };
      }
      case 'copyMessage': {
        const src = this.#chat(p.from_chat_id).messages.get(p.message_id);
        if (!src) throw tgError(400, 'Bad Request: message to copy not found');
        const { id: _id, chat: _chat, at: _at, ...body } = src; // a copy is a NEW message: new id, new chat, new time
        return { message_id: this.#add(p.chat_id, { ...body, caption: p.caption ?? src.caption, reply: p.reply_parameters?.message_id ?? null, copiedFrom: `${p.from_chat_id}:${p.message_id}` }) };
      }
      case 'deleteMessages': {
        const c = this.#chat(p.chat_id);
        for (const id of p.message_ids) c.messages.delete(id);
        return true;
      }
      case 'createForumTopic': {
        const c = this.#chat(p.chat_id);
        if (!c.is_forum) throw tgError(400, 'Bad Request: the chat is not a forum');
        const id = ++this.topicSeq;
        c.topics.push({ id, name: p.name });
        return { message_thread_id: id, name: p.name };
      }
      case 'getChat': { const c = this.#chat(p.chat_id); return { id: p.chat_id, type: c.type, title: c.title, is_forum: c.is_forum }; }
      case 'getChatMember': {
        const c = this.#chat(p.chat_id);
        if (c.rights === 'none') return { status: 'member' };
        if (c.rights === 'all') return { status: 'administrator', can_post_messages: true, can_edit_messages: true, can_delete_messages: true, can_manage_topics: true };
        return { status: 'administrator', ...c.rights };
      }
      default: throw new Error(`FakeTelegram: ${method} not implemented`);
    }
  }
}

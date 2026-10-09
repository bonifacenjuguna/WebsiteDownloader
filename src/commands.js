import { LANGS } from './copy.js';

// Telegram keeps command lists per SCOPE and per LANGUAGE, and a more specific list always wins over the default one.
// So a command registered earlier (by an older version, or by hand in @BotFather) can survive a plain setMyCommands.
// This makes the menu match the code exactly: it sets the default list, deletes stale lists in every other scope and
// language, and sets the admin list in each admin's own chat. It only changes what differs, so restarts stay cheap.
const SCOPES = ['all_private_chats', 'all_group_chats', 'all_chat_administrators'];
const key = (list) => JSON.stringify((list || []).map((c) => [c.command, c.description]));

export async function syncCommands(tg, { commands, adminCommands, adminIds }) {
  const api = (method, payload) => tg.callApi(method, payload);
  const get = (scope, language_code) => api('getMyCommands', { scope: { type: scope }, ...(language_code ? { language_code } : {}) }).catch(() => null);
  const del = (scope, language_code) => api('deleteMyCommands', { scope: { type: scope }, ...(language_code ? { language_code } : {}) });
  const out = { set: false, removed: 0, adminsOk: 0, adminsFailed: [] };

  try {
    if (key(await get('default')) !== key(commands)) { await api('setMyCommands', { commands, scope: { type: 'default' } }); out.set = true; }
  } catch (e) { console.warn('[commands] could not set the default list:', e?.message); }

  // stale lists that would hide the default one
  const stale = [
    ...SCOPES.map((s) => [s, null]),
    ...Object.keys(LANGS).flatMap((l) => ['default', ...SCOPES].map((s) => [s, l])),
  ];
  for (const [scope, language] of stale) {
    try {
      const cur = await get(scope, language);
      if (cur?.length) { await del(scope, language); out.removed++; }
    } catch { /* keep going */ }
  }

  // admins: their own chat gets the longer list (works once they have messaged the bot)
  for (const id of adminIds) {
    try {
      await api('setMyCommands', { commands: adminCommands, scope: { type: 'chat', chat_id: id } });
      out.adminsOk++;
    } catch (e) { out.adminsFailed.push(`${id} (${e?.description || e?.message || 'failed'})`); }
  }
  console.log(`Commands sync -> default: ${out.set ? 'updated' : 'up to date'} | stale lists removed: ${out.removed} | admin menus: ${out.adminsOk} ok${out.adminsFailed.length ? `, failed: ${out.adminsFailed.join(', ')}` : ''}`);
  return out;
}

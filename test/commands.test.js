import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCommands } from '../src/commands.js';

// A fake Telegram that remembers command lists per scope+language, like the real one.
function fakeTelegram(initial) {
  const store = new Map(Object.entries(initial));
  const k = (p) => `${p.scope?.type}${p.scope?.chat_id ? `:${p.scope.chat_id}` : ''}|${p.language_code || ''}`;
  const calls = [];
  return {
    store, calls,
    async callApi(method, p) {
      calls.push(method);
      if (method === 'getMyCommands') return store.get(k(p)) || [];
      if (method === 'setMyCommands') { store.set(k(p), p.commands); return true; }
      if (method === 'deleteMyCommands') { store.delete(k(p)); return true; }
      throw new Error(method);
    },
  };
}
const c = (command) => ({ command, description: command });

test('stale commands (like /browser) are removed from every scope and language, admin menu is set', async () => {
  const tg = fakeTelegram({
    'default|': [c('start'), c('browser')],
    'all_private_chats|': [c('browser')],
    'default|es': [c('browser')],
    'all_private_chats|ru': [c('browser')],
  });
  const commands = [c('start'), c('help')];
  const adminCommands = [...commands, c('ping')];
  const out = await syncCommands(tg, { commands, adminCommands, adminIds: [42] });

  assert.deepEqual(tg.store.get('default|').map((x) => x.command), ['start', 'help']);
  assert.equal(tg.store.has('all_private_chats|'), false);
  assert.equal(tg.store.has('default|es'), false);
  assert.equal(tg.store.has('all_private_chats|ru'), false);
  assert.deepEqual(tg.store.get('chat:42|').map((x) => x.command), ['start', 'help', 'ping']);
  assert.equal(out.removed, 3);
  for (const list of tg.store.values()) assert.ok(!list.some((x) => x.command === 'browser'));
});

test('nothing is written when everything already matches', async () => {
  const commands = [c('start')];
  const tg = fakeTelegram({ 'default|': commands });
  const out = await syncCommands(tg, { commands, adminCommands: commands, adminIds: [] });
  assert.equal(out.set, false);
  assert.equal(tg.calls.filter((m) => m !== 'getMyCommands').length, 0);
});

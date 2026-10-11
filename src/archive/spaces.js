// The three private spaces and the role each plays:
//   live   channel         current items (preview + ZIP), cleared after LIVE_RETENTION_HOURS
//   vault  channel         cold storage; everything that leaves Live is copied here first and never removed
//   ops    forum group     alerts, errors, deploys, daily digest, logs and admin actions, one topic each
// Roles come from the environment (LIVE_CHANNEL_ID, VAULT_CHANNEL_ID, OPS_CHAT_ID) or from the buttons the bot shows
// an admin when it is added to a chat. The environment wins.
export const ROLES = ['live', 'vault', 'ops'];
export const ROLE_INFO = {
  live: { icon: '📡', name: 'Live', what: 'current items, cleared after the retention period' },
  vault: { icon: '🗄', name: 'Vault', what: 'cold storage, nothing is ever removed' },
  ops: { icon: '🛠', name: 'Ops', what: 'alerts, errors, deploys, digest and logs (needs Topics turned on)' },
};

// What the bot needs in each space. Each entry: [ChatMemberAdministrator field, plain-words name]
const NEED = {
  live: [['can_post_messages', 'post'], ['can_edit_messages', 'edit'], ['can_delete_messages', 'delete']],
  vault: [['can_post_messages', 'post']],
  ops: [['can_manage_topics', 'manage topics']],
};

// a chat can play a role only if it is the right kind
export function kindProblem(role, chat) {
  if (role === 'ops') {
    if (chat.type !== 'supergroup') return 'Ops must be a group with Topics turned on (a supergroup), not a channel or a basic group.';
    if (!chat.is_forum) return 'Turn on Topics in the group settings first.';
    return null;
  }
  return chat.type === 'channel' || chat.type === 'supergroup' ? null : 'Live and Vault should be channels.';
}

// rights the bot is missing for a role (empty = good to go). Channel posting rights are explicit; in a group they come with membership.
export function missingRights(role, member, chat) {
  if (!member) return ['be an admin'];
  if (member.status === 'creator') return [];
  if (member.status !== 'administrator') return ['be an admin'];
  return NEED[role]
    .filter(([field]) => !(chat.type !== 'channel' && field === 'can_post_messages') && member[field] !== true)
    .map(([, name]) => name);
}

export function createSpaces({ store, env = {} }) {
  let cache = null;
  const load = async () => { cache ??= (await store.getSetting('spaces')) || {}; return cache; };
  return {
    async get(role) { return env[role] || (await load())[role]?.chatId || null; },
    async info(role) { const s = (await load())[role]; return env[role] ? { chatId: env[role], title: 'set in the environment', kind: '' } : s || null; },
    async set(role, info) { const all = await load(); cache = { ...all, [role]: { ...info, at: Date.now() } }; await store.setSetting('spaces', cache); },
    async unset(role) { const all = { ...(await load()) }; delete all[role]; cache = all; await store.setSetting('spaces', cache); },
    async all() { const o = {}; for (const r of ROLES) o[r] = await this.info(r); return o; },
    async roleOf(chatId) { for (const r of ROLES) if ((await this.get(r)) === chatId) return r; return null; },
    reset() { cache = null; },
  };
}

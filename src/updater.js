// Non-blocking, "latest wins" status editor: the pipeline never waits on Telegram,
// and rapid updates collapse into the newest text instead of queueing up.
export function makeUpdater(ctx, status) {
  let pending = null;
  let last = '';
  let active = false;
  let done = Promise.resolve();

  async function pump() {
    try {
      while (pending !== null) {
        const text = pending;
        pending = null;
        if (text === last) continue;
        last = text;
        await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, text).catch(() => {});
      }
    } finally { active = false; }
  }

  const fn = (text) => {
    pending = text;
    if (!active) { active = true; done = pump(); }
  };
  fn.flush = async () => { while (active) await done; };
  return fn;
}

// Non-blocking, "latest wins" status editor: the pipeline never waits on Telegram,
// and rapid updates collapse into the newest text instead of queueing up.
// fn(text, markup?) - markup is an optional inline keyboard (used for "Try again" style actions).
export function makeUpdater(ctx, status) {
  let pending = null;
  let last = '';
  let active = false;
  let done = Promise.resolve();

  async function pump() {
    try {
      while (pending !== null) {
        const { text, markup } = pending;
        pending = null;
        const sig = `${text}|${markup ? JSON.stringify(markup.reply_markup) : ''}`;
        if (sig === last) continue;
        last = sig;
        await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, text, markup).catch(() => {});
      }
    } finally { active = false; }
  }

  const fn = (text, markup) => {
    pending = { text, markup };
    if (!active) { active = true; done = pump(); }
  };
  fn.flush = async () => { while (active) await done; };
  return fn;
}

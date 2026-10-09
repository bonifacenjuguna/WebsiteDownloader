// Non-blocking, "latest wins" status editor: the pipeline never waits on Telegram,
// and rapid updates collapse into the newest text instead of queueing up.
//   fn(text)            -> edit the text, keep the default keyboard (the Cancel button while a job runs)
//   fn(text, markup)    -> edit the text with that keyboard
//   fn(text, null)      -> edit the text and remove the keyboard
// Edits are spaced at least ~1.1s apart so Telegram's rate limit is never hit by a fast crawl.
const NO_KEYBOARD = { reply_markup: { inline_keyboard: [] } };
const MIN_GAP_MS = 1100;

export function makeUpdater(ctx, status, defaultMarkup) {
  let pending = null;
  let last = '';
  let lastAt = 0;
  let active = false;
  let done = Promise.resolve();

  async function pump() {
    try {
      while (pending !== null) {
        const { text, markup } = pending;
        pending = null;
        const extra = markup === null ? NO_KEYBOARD : (markup ?? defaultMarkup);
        const sig = `${text}|${extra ? JSON.stringify(extra.reply_markup) : ''}`;
        if (sig === last) continue;
        const wait = lastAt + MIN_GAP_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (pending !== null) continue; // something newer arrived while waiting: send that one instead
        last = sig;
        lastAt = Date.now();
        await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, text, extra).catch(() => {});
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

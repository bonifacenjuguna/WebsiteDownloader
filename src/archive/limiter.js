// Per-chat send limiter. Telegram allows roughly 20 posts a minute into one channel and about one a second; this keeps the
// archive under both, and waits (instead of failing) when it is ahead of itself. Clock and sleep can be replaced in tests.
export class RateLimiter {
  constructor({ perMinute = 15, minGapMs = 1100, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    Object.assign(this, { perMinute, minGapMs, now, sleep });
    this.sent = new Map(); // chat -> [timestamps within the last minute]
  }

  async take(chat) {
    for (;;) {
      const t = this.now();
      const list = (this.sent.get(chat) || []).filter((x) => t - x < 60_000);
      const last = list.at(-1) ?? -Infinity;
      const waitGap = this.minGapMs - (t - last);
      const waitWindow = list.length >= this.perMinute ? 60_000 - (t - list[list.length - this.perMinute]) : 0;
      const wait = Math.max(waitGap, waitWindow);
      if (wait <= 0) {
        list.push(t);
        this.sent.set(chat, list);
        return;
      }
      this.sent.set(chat, list);
      await this.sleep(Math.max(1, wait));
    }
  }
}

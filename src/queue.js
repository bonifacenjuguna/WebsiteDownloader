export class JobQueue {
  // canStart: admission check for starting an EXTRA parallel job (memory, disk). The first job always runs,
  // so a busy machine slows down instead of stalling forever.
  constructor(concurrency, maxWaiting, canStart = () => true) {
    this.concurrency = concurrency;
    this.maxWaiting = maxWaiting;
    this.canStart = canStart;
    this.active = 0;
    this.waiting = [];
    this.throttled = 0; // times a job had to wait for resources (for /stats and /metrics)
    this.timer = null;
  }
  get load() { return this.active + this.waiting.length; }
  add(task) {
    if (this.waiting.length >= this.maxWaiting) throw new Error('QUEUE_FULL');
    return new Promise((resolve, reject) => {
      this.waiting.push({ task, resolve, reject });
      this.#pump();
    });
  }
  #pump() {
    while (this.active < this.concurrency && this.waiting.length) {
      if (this.active > 0 && !this.canStart()) {
        this.throttled++;
        this.timer ??= setTimeout(() => { this.timer = null; this.#pump(); }, 1500);
        return;
      }
      const j = this.waiting.shift();
      this.active++;
      j.task().then(j.resolve, j.reject).finally(() => { this.active--; this.#pump(); });
    }
  }
}

export class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async run(fn) {
    if (this.n <= 0) await new Promise((r) => this.q.push(r));
    else this.n--;
    try { return await fn(); }
    finally {
      const next = this.q.shift();
      if (next) next(); else this.n++;
    }
  }
}

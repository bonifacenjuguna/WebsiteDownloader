export class JobQueue {
  constructor(concurrency, maxWaiting) {
    this.concurrency = concurrency;
    this.maxWaiting = maxWaiting;
    this.active = 0;
    this.waiting = [];
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

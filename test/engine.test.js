import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { JobQueue } from '../src/queue.js';
import { eligible } from '../src/sharedcache.js';
import { withHost, readBody } from '../src/net.js';
import { inc, observe, render } from '../src/metrics.js';
import { Job } from '../src/job.js';
import { collectAssets } from '../src/assets.js';

test('shared cache only takes files that can never change', () => {
  const yes = [
    'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js',
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css',
    'https://unpkg.com/react@18.2.0/umd/react.production.min.js',
    'https://code.jquery.com/jquery-3.6.0.min.js',
    'https://fonts.gstatic.com/s/inter/v12/UcC73FwrK3iLTeHuS_fvQtMwCp50KnMa1ZL7.woff2',
    'https://use.fontawesome.com/releases/v6.4.0/css/all.css',
  ];
  const no = [
    'https://cdn.jsdelivr.net/npm/bootstrap@latest/dist/css/bootstrap.min.css',
    'https://unpkg.com/react@18/umd/react.production.min.js',
    'https://cdn.jsdelivr.net/npm/some-lib/dist/lib.js',
    'https://example.com/jquery-3.6.0.min.js',
    'https://kit.fontawesome.com/abc123.js',
    'ftp://cdnjs.cloudflare.com/ajax/libs/x/1.2.3/x.js',
  ];
  for (const u of yes) assert.equal(eligible(u), true, u);
  for (const u of no) assert.equal(eligible(u), false, u);
});

test('per-host cap: never more than the cap in flight, everything still completes', async () => {
  let now = 0; let peak = 0; let done = 0;
  await Promise.all(Array.from({ length: 30 }, () => withHost('cap-test.example', async () => {
    now++; peak = Math.max(peak, now);
    await new Promise((r) => setTimeout(r, 5));
    now--; done++;
  })));
  assert.equal(done, 30);
  assert.ok(peak <= 8 && peak >= 2, `peak was ${peak}`);
});

test('a download that goes quiet is abandoned; a steady one finishes', async () => {
  const stalled = { headers: new Headers(), body: Readable.from((async function* () { yield Buffer.from('a'); await new Promise((r) => setTimeout(r, 400)); yield Buffer.from('b'); })()) };
  await assert.rejects(() => readBody(stalled, 1e6, { stallMs: 60 }), /stalled/);
  const steady = { headers: new Headers(), body: Readable.from((async function* () { for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 20)); yield Buffer.from('xx'); } })()) };
  const got = await readBody(steady, 1e6, { stallMs: 100 });
  assert.equal(got.size, 10);
  const big = { headers: new Headers(), body: Readable.from([Buffer.alloc(50), Buffer.alloc(50)]) };
  assert.equal((await readBody(big, 60, { stallMs: 100 })).tooBig, true);
});

test('queue: an extra parallel job waits while resources are short, the first always runs', async () => {
  let ok = false;
  const q = new JobQueue(3, 10, () => ok);
  const started = [];
  const run = (n) => q.add(async () => { started.push(n); await new Promise((r) => setTimeout(r, 30)); });
  const all = [run(1), run(2), run(3)];
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(started, [1]);            // first job ran, the others are held back
  assert.ok(q.throttled > 0);
  ok = true;                                  // resources free up: the pump retries on its own
  await Promise.all(all);
  assert.deepEqual(started.sort(), [1, 2, 3]);
});

test('metrics render counters, a histogram and gauges', () => {
  inc('wd_jobs_total', { result: 'ok', mode: 'site-pages' });
  inc('wd_jobs_total', { result: 'ok', mode: 'site-pages' });
  observe('wd_job_seconds', 12);
  const out = render({ wd_queue_active: 1, wd_missing: null });
  assert.match(out, /wd_jobs_total\{result="ok",mode="site-pages"\} 2/);
  assert.match(out, /wd_job_seconds_bucket\{le="30"\} 1/);
  assert.match(out, /wd_job_seconds_count 1/);
  assert.match(out, /wd_queue_active 1/);
  assert.doesNotMatch(out, /wd_missing/);
});

test('asset pipeline: stylesheets are read as they arrive and everything they name is fetched', async () => {
  const site = {
    '/a.css': ['text/css', 'body{background:url(b.png)} @import "c.css";'],
    '/c.css': ['text/css', 'h1{background:url(d.png)} @import "e.css";'],
    '/e.css': ['text/css', 'p{background:url(f.png)}'],
    '/b.png': ['image/png', 'B'], '/d.png': ['image/png', 'D'], '/f.png': ['image/png', 'F'],
  };
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const p = new URL(u).pathname;
    seen.push(p);
    const hit = site[p];
    return hit ? new Response(hit[1], { status: 200, headers: { 'content-type': hit[0] } }) : new Response('', { status: 404 });
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-test-'));
  try {
    const job = new Job(dir, 'http://8.8.8.8/', { timeoutMs: 20000, fetchTimeoutMs: 5000 });
    await collectAssets(job, [], 'http://8.8.8.8/', ['http://8.8.8.8/a.css']);
    const got = [...job.files.keys()].map((u) => new URL(u).pathname).sort();
    assert.deepEqual(got, ['/a.css', '/b.png', '/c.css', '/d.png', '/e.css', '/f.png']);
    assert.equal(new Set(seen).size, seen.length, 'no file fetched twice');
    assert.equal(job.progress.done, job.progress.total);
  } finally {
    globalThis.fetch = realFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

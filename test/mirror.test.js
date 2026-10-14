import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { Job } from '../src/job.js';
import { optimizeLossless, pngIsSafe, kindOf } from '../src/optimize.js';
import { measureZipSizes, entryOverhead } from '../src/measure.js';
import { estimate } from '../src/trim.js';
import { createSignInTracker } from '../src/signin.js';
import { rewriteLink, rewriteHtml } from '../src/extract.js';
import { packPrioritized } from '../src/site-util.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'wd-mirror-'));
const newJob = async () => new Job(await tmp(), 'https://e.com/', { timeoutMs: 60_000 });

// minimal but valid-looking headers: that is all the optimizer's safety checks read
function png(size, { bitDepth = 8, apng = false, fill = 1 } = {}) {
  const b = Buffer.alloc(size, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(100, 16); b.writeUInt32BE(100, 20); b[24] = bitDepth; b[25] = 6;
  if (apng) b.write('acTL', 40, 'latin1');
  return b;
}
const jpeg = (size, fill = 2) => { const b = Buffer.alloc(size, fill); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0; return b; };

// a pretend engine: the result is 80% of the input, and whether the pixels match is the test's decision
const engine = (over = {}) => ({ available: true, png: async (b) => b.subarray(0, Math.floor(b.length * 0.8)), jpeg: async (b) => b.subarray(0, Math.floor(b.length * 0.8)), samePixels: async () => true, ...over });

test('lossless optimizing keeps a smaller file only when its pixels are identical', async () => {
  const job = await newJob();
  const a = await job.add('https://e.com/a.png', png(100_000, { fill: 3 }), 'image/png');
  const b = await job.add('https://e.com/b.jpg', jpeg(80_000), 'image/jpeg');
  const before = job.totalBytes;
  const r = await optimizeLossless(job, { engine: engine() });
  assert.equal(r.count, 2);
  assert.equal(a.size, 80_000);
  assert.equal(b.size, 64_000);
  assert.equal((await fs.stat(path.join(job.dir, a.local))).size, 80_000, 'the file on disk is the smaller one');
  assert.equal(job.totalBytes, before - 20_000 - 16_000, 'the job totals follow');
  assert.equal(r.saved, 36_000);
});

test('a result that is NOT pixel-identical is thrown away and the original stays', async () => {
  const job = await newJob();
  const orig = png(100_000, { fill: 7 });
  const a = await job.add('https://e.com/a.png', orig, 'image/png');
  const r = await optimizeLossless(job, { engine: engine({ samePixels: async () => false }) });
  assert.equal(r.count, 0);
  assert.equal(r.rejected.pixels, 1);
  assert.equal(a.size, 100_000);
  assert.ok((await fs.readFile(path.join(job.dir, a.local))).equals(orig), 'byte for byte the original');
});

test('under 3% saved is not worth touching; animated and 16-bit PNGs are never touched; a crashing engine changes nothing', async () => {
  const job = await newJob();
  const tiny = await job.add('https://e.com/tiny.png', png(100_000, { fill: 4 }), 'image/png');
  const anim = await job.add('https://e.com/anim.png', png(100_000, { apng: true, fill: 5 }), 'image/png');
  const deep = await job.add('https://e.com/deep.png', png(100_000, { bitDepth: 16, fill: 6 }), 'image/png');
  let calls = 0;
  const r = await optimizeLossless(job, { engine: engine({ png: async (b) => { calls++; return b.subarray(0, Math.floor(b.length * 0.98)); } }) });
  assert.equal(r.count, 0);
  assert.equal(calls, 1, 'only the plain PNG was even tried');
  assert.equal(r.rejected.gain, 1);
  assert.equal(r.rejected.unsafe, 2);
  for (const f of [tiny, anim, deep]) assert.equal(f.size, 100_000);
  const crash = await optimizeLossless(job, { engine: engine({ png: async () => { throw new Error('boom'); } }) });
  assert.equal(crash.count, 0);
  assert.equal(crash.rejected.error, 1);
  assert.equal(pngIsSafe(png(1000, { apng: true })), false);
  assert.equal(pngIsSafe(png(1000, { bitDepth: 16 })), false);
  assert.equal(pngIsSafe(png(1000)), true);
  assert.equal(kindOf('x', png(100)), 'png');
  assert.equal(kindOf('x', jpeg(100)), 'jpeg');
  assert.equal(kindOf('x', Buffer.from('GIF89a')), null);
});

test('with nothing to verify with, nothing is touched; other files are never touched; time is respected', async () => {
  const job = await newJob();
  const a = await job.add('https://e.com/a.png', png(100_000, { fill: 8 }), 'image/png');
  await job.add('https://e.com/app.js', Buffer.alloc(50_000, 'x'), 'text/javascript');
  const none = await optimizeLossless(job, { engine: { available: false } });
  assert.deepEqual([none.count, none.engine], [0, false]);
  assert.equal(a.size, 100_000);

  const job2 = await newJob();
  for (let i = 0; i < 5; i++) await job2.add(`https://e.com/${i}.png`, png(100_000 + i * 1000, { fill: 10 + i }), 'image/png');
  let t = 0;
  const r = await optimizeLossless(job2, { engine: engine({ png: async (b) => { t += 600; return b.subarray(0, Math.floor(b.length * 0.8)); } }), maxMs: 1000, now: () => t });
  assert.ok(r.count >= 1 && r.count < 5, `stopped on time: ${r.count} of 5`);
});

test('identical binary files are stored once; text is never merged; every address still resolves', async () => {
  const job = await newJob();
  const bytes = png(60_000, { fill: 9 });
  const one = await job.add('https://e.com/img/logo.png', bytes, 'image/png');
  const two = await job.add('https://cdn.e.com/logo-copy.png?v=2', Buffer.from(bytes), 'image/png');
  const three = await job.add('https://e.com/other.png', png(60_000, { fill: 11 }), 'image/png');
  assert.equal(two.alias, true);
  assert.equal(two.local, one.local, 'one file on disk');
  assert.equal(three.alias, undefined);
  assert.equal(job.dedupedBytes, 60_000);
  assert.equal(job.totalBytes, 120_000, 'the shared bytes count once');
  assert.equal(job.files.size, 3, 'but all three addresses are known');
  const css = Buffer.from('body{color:red}');
  const c1 = await job.add('https://e.com/a/x.css', css, 'text/css');
  const c2 = await job.add('https://e.com/b/x.css', Buffer.from(css), 'text/css');
  assert.notEqual(c1.local, c2.local, 'stylesheets are rewritten per address, so they are never merged');
  const s1 = await job.add('https://e.com/a.svg', Buffer.from('<svg/>'), 'image/svg+xml');
  const s2 = await job.add('https://e.com/b.svg', Buffer.from('<svg/>'), 'image/svg+xml');
  assert.notEqual(s1.local, s2.local, 'SVG can contain links, so it is not merged either');
});

test('real sizes inside the ZIP: text is measured by deflating it, media is stored as it is, aliases and entries counted properly', async () => {
  const job = await newJob();
  await job.add('https://e.com/big.js', Buffer.from('var a = 1;\n'.repeat(20_000)), 'text/javascript');
  const img = await job.add('https://e.com/p.png', png(50_000, { fill: 12 }), 'image/png');
  const twin = await job.add('https://e.com/p2.png', Buffer.from(await fs.readFile(path.join(job.dir, img.local))), 'image/png');
  const pages = [{ html: '<p>hello</p>'.repeat(5000), local: 'index.html' }];
  await measureZipSizes(job, pages);
  const js = [...job.files.values()].find((f) => f.local.endsWith('.js'));
  assert.ok(js.zsize < js.size * 0.05, `repetitive text compresses a lot: ${js.zsize} of ${js.size}`);
  assert.equal(img.zsize, 50_000 + entryOverhead(img.local), 'a PNG is stored as it is, plus its header');
  assert.equal(twin.zsize, undefined, 'an alias adds nothing');
  assert.ok(pages[0].zsize < 600);
  // the record shape the crawler really passes: { local, size, page: { html } }
  const crawlerShaped = [{ local: 'about/index.html', size: 70_000, page: { html: '<p>x</p>'.repeat(10_000) } }];
  await measureZipSizes(job, crawlerShaped);
  assert.ok(crawlerShaped[0].zsize < 1000, 'pages from the crawler are measured too, not left on the guess');
  assert.equal(estimate(js), js.zsize, 'packing uses the measured size');
  assert.equal(estimate({ local: 'x.js', type: '', size: 1000 }), 350, 'and the old guess only when nothing was measured');
  // with real sizes, parts fill right up to the limit
  const files = [60, 40, 35, 30].map((n, i) => ({ url: `u${i}`, local: `f${i}.png`, type: 'image/png', size: n, zsize: n }));
  const { bins, overflow } = packPrioritized(files, { capacity: 100, maxParts: 2, weigh: (f) => f.zsize, rankOf: () => 1 });
  assert.equal(overflow.length, 0);
  assert.deepEqual(bins.map((b) => b.bytes), [100, 65]);
});

test('sign-in pages: saved once, every protected page points at it, a left-out sign-in page leaves the live link', () => {
  const t = createSignInTracker();
  t.add('e.com/account', 'e.com/login');
  t.add('e.com/orders', 'e.com/login');
  const pages = new Map([['e.com/login', { local: 'login/index.html' }]]);
  assert.equal(t.localFor('e.com/account', pages), 'login/index.html');
  assert.equal(t.localFor('e.com/orders', pages), 'login/index.html');
  assert.equal(t.localFor('e.com/about', pages), undefined, 'ordinary pages are not affected');
  assert.equal(t.count, 2);
  assert.deepEqual([...t.signInKeys()], ['e.com/login']);
  pages.delete('e.com/login');
  assert.equal(t.localFor('e.com/account', pages), undefined, 'if the sign-in page did not fit, the link stays live');
});

test('embedded players get complete addresses', () => {
  const base = 'https://shop.example/blog/post';
  assert.equal(rewriteLink('//player.vimeo.com/video/1', base, 'index.html', null), 'https://player.vimeo.com/video/1');
  assert.equal(rewriteLink('/embed/clip', base, 'index.html', null), 'https://shop.example/embed/clip');
  assert.equal(rewriteLink('https://www.youtube.com/embed/x', base, 'index.html', null), 'https://www.youtube.com/embed/x');
  assert.equal(rewriteLink('javascript:void(0)', base, 'index.html', null), null);
  assert.equal(rewriteLink('about:blank', base, 'index.html', null), null);
  const lookup = (u) => (u === 'https://shop.example/embed/clip' ? 'embed/clip/index.html' : undefined);
  assert.equal(rewriteLink('/embed/clip', base, 'blog/post/index.html', lookup), '../../embed/clip/index.html', 'a saved page opens locally');
});

const hasCheerio = (() => { try { cheerio.load('<p>'); return true; } catch { return false; } })();
test('in a real page: iframes, saved files, shared files and skipped media', { skip: !hasCheerio && 'needs the real cheerio package' }, () => {
  const html = `<html><head><link rel="stylesheet" href="/s.css"></head><body>
    <iframe src="//player.vimeo.com/video/9"></iframe><iframe src="/embed/clip"></iframe>
    <img src="/img/logo.png"><img src="https://cdn.e.com/logo-copy.png?v=2">
    <video src="/media/huge.mp4" poster="/img/logo.png"></video>
    <a href="/media/huge.mp4">download</a>
  </body></html>`;
  const files = new Map([
    ['https://shop.example/s.css', { local: 's.css' }],
    ['https://shop.example/img/logo.png', { local: 'img/logo.png' }],
    ['https://cdn.e.com/logo-copy.png?v=2', { local: 'img/logo.png', alias: true }],   // the same bytes, stored once
  ]);
  const $ = cheerio.load(html);
  rewriteHtml($, 'https://shop.example/', files, { from: 'index.html' });
  assert.equal($('iframe').eq(0).attr('src'), 'https://player.vimeo.com/video/9');
  assert.equal($('iframe').eq(1).attr('src'), 'https://shop.example/embed/clip');
  assert.equal($('img').eq(0).attr('src'), 'img/logo.png');
  assert.equal($('img').eq(1).attr('src'), 'img/logo.png', 'the shared file is used by both addresses');
  assert.equal($('video').attr('src'), 'https://shop.example/media/huge.mp4', 'a video that was left out keeps its live address');
  assert.equal($('video').attr('poster'), 'img/logo.png');
  assert.equal($('a').attr('href'), 'https://shop.example/media/huge.mp4');
});

test('the Docker image installs jpegtran (lossless JPEG optimizing)', () => {
  const docker = fsSync.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(docker, /libjpeg-turbo-progs/);
});

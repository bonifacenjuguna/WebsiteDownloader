import test from 'node:test';
import assert from 'node:assert/strict';
import { initStore } from '../src/store.js';
import { save, probe, available, lastCheck } from '../src/fingerprint.js';
import { signature } from '../src/signature.js';

await initStore();

const HOST = 'http://8.8.8.8';           // an IP literal: public, so no DNS lookup is needed
const html = (body = 'Price: 20', head = '') => `<html><head><title>Shop</title><link rel="stylesheet" href="/a.css">${head}</head><body>${body}</body></html>`;
let n = 0;
const nextKey = () => `probe-test-${++n}`;
const BUILT = Date.parse('2026-10-10T12:00:00Z');
const baseline = (over = {}) => ({ at: BUILT, sitemaps: [], entries: [{ u: `${HOST}/`, e: null, m: null, s: signature(html()) }], ...over });

// a tiny website: path -> handler(request) -> Response
function website(routes) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const p = new URL(url).pathname;
    calls.push({ path: p, headers: init.headers || {} });
    const h = routes[p];
    return h ? h(init) : new Response('', { status: 404 });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const ok = (body, headers = {}) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });

test('unchanged: a 304 answer, or the same page with different noise', async () => {
  const key = nextKey();
  await save(key, baseline({ entries: [{ u: `${HOST}/`, e: '"v1"', m: null, s: signature(html()) }] }));
  let site = website({ '/': () => new Response(null, { status: 304 }) });
  let r = await probe(key, { timeoutMs: 3000 });
  site.restore();
  assert.equal(r.verdict, 'unchanged');
  assert.equal(site.calls[0].headers['if-none-match'], '"v1"', 'the check is a conditional request');

  const key2 = nextKey();
  await save(key2, baseline());
  site = website({ '/': ok(html('Price: 20').replace('Shop', 'Shop')) });
  r = await probe(key2, { timeoutMs: 3000 });
  site.restore();
  assert.equal(r.verdict, 'unchanged');
});

test('changed: new text, a renamed script, or a newer sitemap date', async () => {
  let key = nextKey();
  await save(key, baseline());
  let site = website({ '/': ok(html('Price: 25')) });
  let r = await probe(key, { timeoutMs: 3000 });
  site.restore();
  assert.equal(r.verdict, 'changed');
  assert.equal(r.reason, 'page');

  key = nextKey();
  await save(key, baseline());
  site = website({ '/': ok(html('Price: 20', '<script src="/app.9f3c.js"></script>')) });
  r = await probe(key, { timeoutMs: 3000 });
  site.restore();
  assert.equal(r.verdict, 'changed', 'a redeploy is noticed');

  key = nextKey();
  await save(key, baseline({ sitemaps: [`${HOST}/sitemap.xml`], entries: [{ u: `${HOST}/p`, e: null, m: null, s: signature(html()) }] }));
  site = website({
    '/sitemap.xml': ok(`<urlset><url><loc>${HOST}/p</loc><lastmod>2026-10-11T08:00:00Z</lastmod></url></urlset>`, { 'content-type': 'application/xml' }),
    '/p': ok(html()),
  });
  r = await probe(key, { timeoutMs: 3000 });
  site.restore();
  assert.equal(r.verdict, 'changed');
  assert.equal(r.reason, 'sitemap');
  assert.deepEqual(site.calls.map((c) => c.path), ['/sitemap.xml'], 'the sitemap settled it with one request');

  key = nextKey();
  await save(key, baseline({ sitemaps: [`${HOST}/sitemap.xml`], entries: [{ u: `${HOST}/p`, e: null, m: null, s: signature(html()) }] }));
  site = website({ '/sitemap.xml': ok(`<urlset><url><loc>${HOST}/p</loc><lastmod>2026-10-09T08:00:00Z</lastmod></url></urlset>`), '/p': ok(html()) });
  r = await probe(key, { timeoutMs: 3000 });
  site.restore();
  assert.equal(r.verdict, 'unchanged', 'an OLDER sitemap date is not a change');
});

test('unknown: no baseline, an old-format baseline, an unreachable site, a slow site; never a rebuild by itself', async () => {
  assert.equal((await probe(nextKey())).verdict, 'unknown');
  assert.equal((await probe(nextKey())).reason, 'no-baseline');

  const { kv } = await import('../src/store.js');
  const oldKey = nextKey();
  await kv.set(`fp:${oldKey}`, JSON.stringify([{ u: `${HOST}/`, h: 'abc' }]), 60_000);   // the format of older versions
  assert.equal(await available(oldKey), false);
  assert.equal((await probe(oldKey)).verdict, 'unknown');

  let key = nextKey();
  await save(key, baseline());
  let site = website({ '/': () => new Response('down', { status: 503 }) });
  let r = await probe(key, { timeoutMs: 3000 });
  site.restore();
  assert.deepEqual([r.verdict, r.reason], ['unknown', 'unreachable']);

  key = nextKey();
  await save(key, baseline());
  site = website({ '/': (init) => new Promise((resolve, reject) => { const t = setTimeout(() => resolve(new Response(html(), { status: 200, headers: { 'content-type': 'text/html' } })), 5000); init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })); }); }) });
  const t0 = Date.now();
  r = await probe(key, { timeoutMs: 600 });
  site.restore();
  assert.deepEqual([r.verdict, r.reason], ['unknown', 'timeout']);
  assert.ok(Date.now() - t0 < 3000, 'the check respects its time limit');
});

test('a partial check is never called "unchanged"', async () => {
  const key = nextKey();
  const entries = [`${HOST}/`, `${HOST}/a`, `${HOST}/b`].map((u) => ({ u, e: null, m: null, s: signature(html()) }));
  await save(key, baseline({ entries }));
  const site = website({ '/': ok(html()), '/a': ok(html()), '/b': () => new Response('', { status: 500 }) });
  const r = await probe(key, { timeoutMs: 3000 });
  site.restore();
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.checked, 2);
  assert.equal(r.total, 3);
});

test('the same question twice within a minute asks the site once', async () => {
  const key = nextKey();
  await save(key, baseline());
  const site = website({ '/': ok(html()) });
  await probe(key, { timeoutMs: 3000 });
  const again = await probe(key, { timeoutMs: 3000 });
  site.restore();
  assert.equal(site.calls.length, 1);
  assert.equal(again.verdict, 'unchanged');
  assert.equal((await lastCheck(key)).verdict, 'unchanged');
});

test('a change on any page counts, even when the home page is the same', async () => {
  const key = nextKey();
  await save(key, baseline({ entries: [`${HOST}/`, `${HOST}/a`].map((u) => ({ u, e: null, m: null, s: signature(html()) })) }));
  const site = website({ '/': ok(html()), '/a': ok(html('Price: 99')) });
  const r = await probe(key, { timeoutMs: 3000 });
  site.restore();
  assert.deepEqual([r.verdict, r.page], ['changed', `${HOST}/a`]);
});

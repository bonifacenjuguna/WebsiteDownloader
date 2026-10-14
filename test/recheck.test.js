import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, describeDuration } from '../src/duration.js';
import { decideFreshness, afterCheck } from '../src/recheck.js';
import { signature, visibleText, assetName } from '../src/signature.js';
import { parseSitemapXml } from '../src/site-util.js';

const MIN = 60_000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;

test('RECHECK_AFTER understands plain durations and survives typos', () => {
  const fb = 99;
  assert.equal(parseDuration('10m', fb), 10 * MIN);
  assert.equal(parseDuration('30m', fb), 30 * MIN);
  assert.equal(parseDuration('2h', fb), 2 * HOUR);
  assert.equal(parseDuration('1d', fb), DAY);
  assert.equal(parseDuration('7d', fb), 7 * DAY);
  assert.equal(parseDuration('1w', fb), 7 * DAY);
  assert.equal(parseDuration('90s', fb), 90_000);
  assert.equal(parseDuration('1.5h', fb), 90 * MIN);
  assert.equal(parseDuration('15', fb), 15 * MIN, 'a bare number means minutes');
  assert.equal(parseDuration(' 5M ', fb), 5 * MIN, 'spaces and capitals are fine');
  assert.equal(parseDuration('0', fb), 0, 'zero = check every time');
  for (const bad of ['', undefined, null, 'soon', '-5m', '10x', '1d2h', 'm10', '1,5h']) assert.equal(parseDuration(bad, fb), fb, `${bad}`);
  assert.equal(describeDuration(10 * MIN), '10 minutes');
  assert.equal(describeDuration(DAY), '1 day');
  assert.equal(describeDuration(0), 'every time');
});

const base = { now: 1_000 * DAY, recheckAfterMs: 10 * MIN, staleMaxMs: 7 * DAY };
const copy = (agoMs, checkedAgoMs) => ({ at: base.now - agoMs, ...(checkedAgoMs != null ? { checkedAt: base.now - checkedAgoMs } : {}) });

test('freshness: send what we have only while it was verified recently, otherwise check, and never trust an old copy', () => {
  assert.equal(decideFreshness({ ...base, prev: null }).action, 'build');
  assert.deepEqual(decideFreshness({ ...base, prev: copy(3 * MIN) }), { action: 'send', label: 'cache', why: 'fresh-enough', verifiedAge: 3 * MIN });
  assert.equal(decideFreshness({ ...base, prev: copy(3 * HOUR) }).action, 'check');
  assert.equal(decideFreshness({ ...base, prev: copy(3 * HOUR, 2 * MIN) }).action, 'send', 'a recent check counts as fresh');
  assert.equal(decideFreshness({ ...base, prev: copy(3 * HOUR, 20 * MIN) }).action, 'check');
  assert.equal(decideFreshness({ ...base, prev: copy(8 * DAY, 1 * MIN) }).action, 'build', 'older than STALE_MAX_DAYS is simply rebuilt');
  assert.equal(decideFreshness({ ...base, prev: copy(1 * MIN), repeat: true }).action, 'check', 'the same person asking again wants it fresh');
  assert.equal(decideFreshness({ ...base, prev: copy(1 * MIN), force: true }).action, 'build');
  assert.equal(decideFreshness({ ...base, prev: copy(3 * MIN), recheckAfterMs: 0 }).action, 'check', '0 = every time');
  assert.equal(decideFreshness({ ...base, prev: copy(3 * MIN), recheckAfterMs: 7 * DAY }).action, 'send', '7d: a week of "fresh enough"');
});

test('after a check: unchanged sends, changed rebuilds for free, unknown sends honestly unless they asked twice', () => {
  assert.deepEqual(afterCheck('unchanged'), { action: 'send', label: 'unchanged', free: false });
  assert.deepEqual(afterCheck('changed'), { action: 'build', free: true });
  assert.deepEqual(afterCheck('changed', { repeat: true }), { action: 'build', free: true });
  assert.deepEqual(afterCheck('unknown'), { action: 'send', label: 'unverified', free: false });
  assert.deepEqual(afterCheck('unknown', { repeat: true }), { action: 'build', free: false });
});

test('a copy that can never be verified is not served for days', () => {
  const six = 6 * HOUR;
  assert.equal(afterCheck('unknown', { reason: 'no-baseline', verifiedAgeMs: 2 * HOUR, unverifiableMaxMs: six }).action, 'send');
  assert.equal(afterCheck('unknown', { reason: 'no-baseline', verifiedAgeMs: 7 * HOUR, unverifiableMaxMs: six }).action, 'build');
  assert.equal(afterCheck('unknown', { reason: 'unreachable', verifiedAgeMs: 3 * DAY, unverifiableMaxMs: six }).action, 'send', 'a site that is DOWN is exactly when the saved copy is wanted');
  assert.equal(afterCheck('unknown', { reason: 'timeout', verifiedAgeMs: 3 * DAY, unverifiableMaxMs: six }).action, 'send');
});

const page = (extra = '', head = '') => `<html><head><title>Shop</title><link rel="stylesheet" href="/a.css?_=1&ver=2">${head}<script src="/app.js?x=1"></script><script>var t=Date.now()</script></head><body><h1>Hello &amp; welcome</h1><p>Updated 10:32:11 on 2026-10-10T10:32:11Z</p><p>Price: 20</p>${extra}</body></html>`;

test('signature: noise is ignored, real changes are seen', () => {
  const a = page();
  const noise = a.replace('10:32:11', '11:45:02').replace('2026-10-10T10:32:11Z', '2026-10-11T08:00:00Z').replace('Date.now()', 'Date.now()+1').replace('_=1', '_=987654').replace('x=1', 'x=2');
  assert.equal(signature(a), signature(noise));
  assert.notEqual(signature(a), signature(a.replace('Price: 20', 'Price: 25')), 'a text change');
  assert.notEqual(signature(a), signature(a.replace('/app.js', '/app.9f3c1e.js')), 'a redeploy renames the script');
  assert.notEqual(signature(a), signature(a.replace('ver=2', 'ver=3')), 'a version query changes');
  assert.notEqual(signature(a), signature(page('', '<link rel="stylesheet" href="/new.css">')), 'a new stylesheet');
  assert.equal(signature(page('<!-- a comment -->')), signature(a));
  assert.equal(visibleText('<p>a&nbsp;&nbsp;b &#169; &#x41;</p>'), 'a b © A');
  assert.equal(assetName('https://cdn.x.com/a.css?_=1&ver=2#h'), '/a.css?ver=2');
});

test('sitemap: lastmod times are read per page', () => {
  const { urls, lastmod } = parseSitemapXml('<urlset><url><loc>https://e.com/a</loc><lastmod>2026-10-10T12:00:00Z</lastmod></url><url><loc>https://e.com/b</loc></url></urlset>');
  assert.deepEqual(urls, ['https://e.com/a', 'https://e.com/b']);
  assert.equal(lastmod.get('https://e.com/a'), Date.parse('2026-10-10T12:00:00Z'));
  assert.equal(lastmod.has('https://e.com/b'), false);
});

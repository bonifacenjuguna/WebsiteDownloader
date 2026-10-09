import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, extractUrls, urlKey, sectionKey } from '../src/url.js';

test('normalizeUrl adds https, strips fragments, credentials and tracking parameters', () => {
  const { url, explicitScheme } = normalizeUrl('example.com/a?utm_source=x&fbclid=1&keep=2#top');
  assert.equal(url.href, 'https://example.com/a?keep=2');
  assert.equal(explicitScheme, false);
});

test('normalizeUrl rejects non-web input', () => {
  for (const bad of ['', 'hello', 'ftp://example.com', 'javascript:alert(1)', 'localhost']) assert.throws(() => normalizeUrl(bad), /valid website address/);
});

test('extractUrls finds links anywhere in a message, in order, without duplicates', () => {
  const urls = extractUrls('look at https://Example.com/a?utm_medium=x, and foo.co.ke/docs. mail me a@b.com. again example.com/a').map((p) => p.url.href);
  assert.deepEqual(urls, ['https://example.com/a', 'https://foo.co.ke/docs']);
});

test('extractUrls ignores plain text and abbreviations', () => {
  assert.deepEqual(extractUrls('i.e. nothing, e.g. nope. thanks!'), []);
});

test('urlKey ignores www., scheme and trailing slash; sectionKey differs', () => {
  const a = urlKey(new URL('https://www.example.com/docs/'));
  const b = urlKey(new URL('http://example.com/docs'));
  assert.equal(a, b);
  assert.notEqual(a, sectionKey(a));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, b, i, code, dot, ms, uptime, utc, table, titled, styleError, stripTags } from '../src/fmt.js';
import { tr, buildSummary, LANGS } from '../src/copy.js';

// What Telegram accepts: balanced b/i/u/s/code/pre/blockquote/a tags, no stray < > &.
function htmlProblems(s) {
  const problems = [];
  const stack = [];
  let rest = '';
  for (const part of String(s).split(/(<\/?[a-z]+(?:\s[^>]*)?>)/i)) {
    const m = /^<(\/?)([a-z]+)(?:\s[^>]*)?>$/i.exec(part);
    if (!m) { rest += part; continue; }
    const [, close, name] = m;
    if (!['b', 'i', 'u', 's', 'code', 'pre', 'blockquote', 'a'].includes(name.toLowerCase())) problems.push(`tag <${name}> is not allowed`);
    if (!close) stack.push(name.toLowerCase());
    else if (stack.pop() !== name.toLowerCase()) problems.push(`unbalanced </${name}>`);
  }
  if (stack.length) problems.push(`unclosed <${stack.join('>, <')}>`);
  if (/[<>]/.test(rest)) problems.push('stray < or >');
  if (/&(?!(amp|lt|gt|quot|#\d+);)/.test(rest)) problems.push('stray &');
  return problems;
}

test('fmt helpers escape and format', () => {
  assert.equal(esc('Tom & <Jerry>'), 'Tom &amp; &lt;Jerry&gt;');
  assert.equal(b('x'), '<b>x</b>');
  assert.equal(i('x'), '<i>x</i>');
  assert.equal(code('a<b'), '<code>a&lt;b</code>');
  assert.equal(dot(50, 70, 85), '🟢');
  assert.equal(dot(75, 70, 85), '🟡');
  assert.equal(dot(90, 70, 85), '🔴');
  assert.equal(dot(90, 80, 60, true), '🟢');
  assert.equal(dot(null, 1, 2), '⚪');
  assert.equal(ms(850), '850 ms');
  assert.equal(ms(31000), '31.0 s');
  assert.equal(uptime(6 * 3600e3 + 53 * 60e3 + 4e3), '6h 53m');
  assert.equal(uptime(90e3), '1m 30s');
  assert.equal(utc(Date.UTC(2026, 9, 9, 21, 1)), 'Oct 9, 21:01 UTC');
  assert.equal(titled('Title\nbody'), '<b>Title</b>\n<i>body</i>');
  assert.equal(styleError('❓ Not found. Check the URL.'), '<b>❓ Not found.</b>\nCheck the URL.');
  assert.equal(styleError('❌ Try something like example.com'), '<b>❌ Try something like example.com</b>');
  assert.equal(stripTags('<b>a &amp; b</b> &lt;c&gt;'), 'a & b <c>');
  assert.deepEqual(htmlProblems(table([['fetch', '0.8 s'], ['assets', '52.0 s']])), []);
});

test('every message in every language is valid Telegram HTML', () => {
  const sample = ['example.com', 5];
  const check = (where, v) => {
    if (typeof v === 'function') v = v(...sample);
    if (typeof v === 'string') assert.deepEqual(htmlProblems(v), [], `${where}: ${v}`);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) check(`${where}.${k}`, x);
  };
  for (const lang of Object.keys(LANGS)) {
    const L = tr(lang);
    for (const sec of ['STATUS', 'BTN', 'NOTE', 'CAP', 'ERRORS', 'MSG']) check(`${lang}.${sec}`, L[sec]);
    check(`${lang}.START_TEXT`, L.START_TEXT);
    check(`${lang}.previewCaption`, L.previewCaption('example.com'));
  }
});

test('captions stay valid HTML even when a page title is hostile', () => {
  const r = { kind: 'pages', host: 'e.com', title: '<script>alert("x")</script> & <b>unclosed', pages: 2, fileCount: 9, zipBytes: 3e6, skipped: 0, failed: 0, warnings: [{ c: 'signIn' }] };
  const l = { kind: 'listing', host: 'e.com', title: '/a&b/<c>/', fileCount: 4, dirCount: 2, zipBytes: 1e6, skipped: 0, failed: 0, warnings: [] };
  for (const lang of Object.keys(LANGS)) for (const x of [r, l]) {
    const out = tr(lang).caption(JSON.stringify(buildSummary(x, 1)));
    assert.deepEqual(htmlProblems(out), [], out);
  }
});

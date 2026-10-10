import test from 'node:test';
import assert from 'node:assert/strict';
import { tr, ENGLISH, buildSummary, mapLang, LANGS, RETRY_CODES } from '../src/copy.js';
import { LOCALES } from '../src/locales/index.js';

test('every translated key exists in English with the same type', () => {
  for (const [code, loc] of Object.entries(LOCALES)) {
    for (const sec of Object.keys(loc)) {
      if (sec === 'START_TEXT' || sec === 'previewLine') continue;
      for (const k of Object.keys(loc[sec])) {
        assert.ok(k in ENGLISH[sec], `${code}.${sec}.${k} is not an English key`);
        assert.equal(typeof loc[sec][k], typeof ENGLISH[sec][k], `${code}.${sec}.${k} has a different type`);
      }
    }
  }
});

test('every language in LANGS has a locale; unknown codes fall back to English', () => {
  for (const c of Object.keys(LANGS)) assert.ok(c in LOCALES);
  assert.equal(mapLang('pt-BR'), 'pt');
  assert.equal(mapLang('zh'), 'en');
  assert.equal(tr('xx').lang, 'en');
});

test('every error code has human text in every language (falls back to English)', () => {
  for (const c of Object.keys(ENGLISH.ERRORS)) for (const l of Object.keys(LANGS)) assert.ok(tr(l).errorText(c).length > 5);
  for (const c of RETRY_CODES) assert.ok(c in ENGLISH.ERRORS, `${c} has no error text`);
});

test('caption: one note at most, rendered in the reader language, old plain captions pass through', () => {
  const r = { kind: 'pages', host: 'e.com', title: 'E', pages: 3, fileCount: 10, zipBytes: 2e6, skipped: 0, failed: 0, warnings: [{ c: 'pageLimit', n: 300 }, { c: 'signIn' }] };
  const stored = JSON.stringify(buildSummary(r, 1));
  const en = tr('en').caption(stored);
  assert.match(en, /3 pages  ·  🗂 7 files/);
  assert.equal(en.split('\n').filter((l) => /^<i>/.test(l)).length, 1);
  assert.match(tr('es').caption(stored), /3 páginas/);
  assert.match(en, /^✅ <b>e\.com<\/b>/);
  assert.equal(tr('en').caption('✅ old.com'), '✅ old.com');
});

test('progress lines carry a bar in every language', () => {
  for (const l of Object.keys(LANGS)) assert.match(tr(l).STATUS.pages(5, 10), /▰{5}▱{5}/);
});

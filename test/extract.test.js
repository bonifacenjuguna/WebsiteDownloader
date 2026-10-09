import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSrcset, rewriteCss, cssRefs, relPath } from '../src/extract.js';

test('srcset: commas inside URLs stay, descriptors are optional', () => {
  assert.deepEqual(parseSrcset('a.jpg 1x, b,c.jpg 2x, /i/w_3,h_2/x.jpg 480w'), [
    { url: 'a.jpg', desc: '1x' }, { url: 'b,c.jpg', desc: '2x' }, { url: '/i/w_3,h_2/x.jpg', desc: '480w' },
  ]);
  assert.deepEqual(parseSrcset('a.jpg, b.jpg').map((s) => s.url), ['a.jpg', 'b.jpg']);
});

test('css: url(), @import and image-set() strings are found and rewritten', () => {
  const css = '.a{background:image-set("a.png" 1x, "b.png" 2x)} @import url(x.css); .b{background:url(i.png)}';
  const base = 'https://e.com/s/m.css';
  assert.deepEqual([...cssRefs(css, base)].sort(), ['https://e.com/s/a.png', 'https://e.com/s/b.png', 'https://e.com/s/i.png', 'https://e.com/s/x.css']);
  const map = new Map([['https://e.com/s/a.png', { local: 's/a.png' }], ['https://e.com/s/i.png', { local: 'img/i.png' }]]);
  const out = rewriteCss(css, base, 's/m.css', map);
  assert.match(out, /image-set\("a\.png" 1x, "https:\/\/e\.com\/s\/b\.png" 2x\)/);
  assert.match(out, /url\("\.\.\/img\/i\.png"\)/);
});

test('relPath encodes each segment', () => {
  assert.equal(relPath('docs/index.html', 'img/a b.png'), '../img/a%20b.png');
});

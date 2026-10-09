import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRobots, robotsAllows, pageKey, pageLocal, scopePathOf, pageLinksFromHrefs,
  sitemapsFromRobots, parseSitemapXml, sortShallowFirst, packPrioritized,
} from '../src/site-util.js';

test('robots.txt rules: longest match wins, allow beats disallow on ties', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/open\n');
  assert.equal(robotsAllows(rules, '/private/x'), false);
  assert.equal(robotsAllows(rules, '/private/open/a'), true);
  assert.equal(robotsAllows(rules, '/public'), true);
});

test('page identity folds index files and trailing slashes', () => {
  assert.equal(pageKey('https://e.com/docs/'), pageKey('https://e.com/docs/index.html'));
  assert.equal(pageLocal('e.com/docs'), 'docs/index.html');
  assert.equal(pageLocal('e.com/'), 'index.html');
  assert.equal(pageLocal('e.com/a/b.php'), 'a/b.html');
  assert.equal(scopePathOf('/docs'), '/docs/');
});

test('link following stays in scope and skips queries and files', () => {
  const scope = { host: 'e.com', path: '/docs/' };
  const keys = [...pageLinksFromHrefs(['/docs/a', '/blog/x', '/docs/b?page=2', '/docs/f.pdf', 'https://other.com/docs/z', 'a.html'], 'https://e.com/docs/', scope)];
  assert.deepEqual(keys.sort(), ['e.com/docs/a', 'e.com/docs/a.html']);
});

test('sitemap discovery helpers', () => {
  assert.deepEqual(sitemapsFromRobots('Sitemap: https://e.com/s.xml # c\n'), ['https://e.com/s.xml']);
  assert.deepEqual(parseSitemapXml('<urlset><url><loc>https://e.com/a?x=1&amp;y=2</loc></url></urlset>').urls, ['https://e.com/a?x=1&y=2']);
  assert.deepEqual(parseSitemapXml('<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>').maps, ['https://e.com/s1.xml']);
  assert.deepEqual(sortShallowFirst(['e.com/a/b/c', 'e.com/z', 'e.com/a']), ['e.com/a', 'e.com/z', 'e.com/a/b/c']);
});

test('packing never drops code before media', () => {
  const files = [
    { url: 'a', local: 'a.mp4', type: 'video/mp4', size: 90 },
    { url: 'b', local: 'b.js', type: 'text/javascript', size: 60 },
    { url: 'c', local: 'c.css', type: 'text/css', size: 50 },
  ];
  const rankOf = (f) => (f.local.endsWith('.mp4') ? 0 : 3);
  const { bins, overflow } = packPrioritized(files, { capacity: 120, maxParts: 1, weigh: (f) => f.size, rankOf });
  assert.deepEqual(overflow.map((f) => f.local), ['a.mp4']);
  assert.equal(bins.length, 1);
});

import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

const SKIP = /^([a-z][a-z0-9+.-]*:|\/\/|#|$)/i; // scheme (http:, mailto:, data:...), protocol-relative, fragment, empty
const ATTRS = [['a[href]', 'href'], ['area[href]', 'href'], ['img[src]', 'src'], ['script[src]', 'src'], ['link[href]', 'href'],
  ['source[src]', 'src'], ['video[src]', 'src'], ['audio[src]', 'src'], ['video[poster]', 'poster'], ['iframe[src]', 'src']];

// Post-build link check. Every relative link in every saved page must point to a file that is really in the ZIP.
// A broken one is repaired by pointing it back at the live URL (when known), so the copy never has dead links.
export async function checkLinks({ dir, pages, entries, liveUrlFor }) {
  const stats = { checked: 0, fixed: 0, broken: 0 };
  for (const p of pages) {
    const file = path.join(dir, p.local);
    let html;
    try { html = await fs.readFile(file, 'utf8'); } catch { continue; }
    const $ = cheerio.load(html);
    const baseDir = path.posix.dirname(p.local);
    let changed = false;
    for (const [sel, attr] of ATTRS) {
      $(sel).each((_, el) => {
        const v = $(el).attr(attr);
        if (v == null || SKIP.test(v.trim())) return;
        stats.checked++;
        let target = v.trim().split('#')[0].split('?')[0];
        try { target = decodeURIComponent(target); } catch { /* keep as is */ }
        let resolved = path.posix.normalize(path.posix.join(baseDir, target)).replace(/^(\.\/)+/, '');
        if (resolved === '.') resolved = '';
        const asDir = resolved === '' ? 'index.html' : `${resolved.replace(/\/$/, '')}/index.html`;
        if (entries.has(resolved.toLowerCase()) || entries.has(asDir.toLowerCase())) return;
        const live = liveUrlFor(resolved);
        if (live) { $(el).attr(attr, live); stats.fixed++; changed = true; } else stats.broken++;
      });
    }
    if (changed) await fs.writeFile(file, $.html());
  }
  return stats;
}

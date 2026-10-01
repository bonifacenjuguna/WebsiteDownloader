import { CFG, mb } from './config.js';
import { assertPublicHost } from './net.js';
import { resolveUrl } from './extract.js';

const KEEP = new Set(['stylesheet', 'script', 'image', 'font', 'media', 'manifest']);

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const t = setInterval(() => {
        window.scrollBy(0, 600);
        y += 600;
        if (y >= document.body.scrollHeight || y > 20000) {
          clearInterval(t);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 150);
    });
  });
}

export async function renderWithBrowser(job, url) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  try {
    const context = await browser.newContext({
      userAgent: CFG.ua,
      viewport: { width: 1366, height: 900 },
      serviceWorkers: 'block',
    });

    // every request the browser makes goes through the SSRF check
    await context.route('**/*', async (route) => {
      try {
        const u = new URL(route.request().url());
        if (u.protocol === 'data:' || u.protocol === 'blob:') return await route.continue();
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return await route.abort();
        await assertPublicHost(u.hostname);
        return await route.continue();
      } catch {
        return route.abort('blockedbyclient').catch(() => {});
      }
    });

    const page = await context.newPage();
    const tasks = [];
    page.on('response', (resp) => {
      tasks.push((async () => {
        try {
          if (!KEEP.has(resp.request().resourceType()) || !resp.ok()) return;
          const key = resolveUrl(resp.url(), job.main.href);
          if (!key) return;
          const h = resp.headers();
          const len = Number(h['content-length'] || 0);
          if (len > CFG.maxFileBytes) {
            job.skipped.push({ url: key, reason: `larger than ${mb(CFG.maxFileBytes)} MB`, size: len });
            return;
          }
          const buf = await resp.body();
          if (buf.length > CFG.maxFileBytes) {
            job.skipped.push({ url: key, reason: `larger than ${mb(CFG.maxFileBytes)} MB`, size: buf.length });
            return;
          }
          await job.add(key, buf, (h['content-type'] || '').split(';')[0].trim().toLowerCase());
        } catch { /* body unavailable (redirect, aborted) */ }
      })());
    });

    const left = () => Math.max(5000, job.deadline - Date.now());
    let mainResp = null;
    try {
      mainResp = await page.goto(url, { waitUntil: 'load', timeout: Math.min(30000, left()) });
    } catch (e) {
      if (!/timeout/i.test(String(e?.message))) throw e;
    }
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await autoScroll(page).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    await Promise.allSettled([...tasks]);

    const html = await page.content();
    const originalHtml = mainResp ? await mainResp.text().catch(() => null) : null;
    return {
      html,
      originalHtml,
      finalUrl: page.url(),
      status: mainResp?.status() ?? 200,
      headers: new Headers(mainResp?.headers() ?? {}),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

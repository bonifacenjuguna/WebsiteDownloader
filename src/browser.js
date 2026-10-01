import { CFG, mb } from './config.js';
import { assertPublicHost } from './net.js';
import { resolveUrl } from './extract.js';
import { Semaphore } from './queue.js';

const KEEP = new Set(['stylesheet', 'script', 'image', 'font', 'media', 'manifest']);
const TRACKERS = /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|facebook\.net|hotjar\.com|clarity\.ms|segment\.io|segment\.com|mixpanel\.com|sentry\.io|intercom\.io|fullstory\.com|newrelic\.com|nr-data\.net)$/i;

// Shared by downloads and previews so total parallel pages stay capped.
export const browserSem = new Semaphore(CFG.browserConcurrency);

// One long-lived Chromium; each job gets its own cheap, isolated context.
let browser = null;
let launching = null;
let active = 0;
let served = 0;

async function ensure() {
  if (browser) return;
  launching ??= (async () => {
    const { chromium } = await import('playwright');
    const b = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    b.on('disconnected', () => { if (browser === b) browser = null; });
    browser = b;
    served = 0;
  })().finally(() => { launching = null; });
  await launching;
}

async function acquire() {
  // recycle periodically to keep memory flat, but never while a page is in use
  if (browser && active === 0 && served >= CFG.browserRecycleAfter) {
    const old = browser;
    browser = null;
    old.close().catch(() => {});
  }
  await ensure();
  if (!browser) throw new Error('browser unavailable');
  active++;
  served++;
  return browser;
}

export async function warmBrowser() { await ensure(); }
export async function closeBrowser() { if (browser) await browser.close().catch(() => {}); browser = null; }

// every request the browser makes goes through the SSRF check; trackers are dropped for speed
async function guard(route) {
  try {
    const u = new URL(route.request().url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return await route.continue();
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return await route.abort();
    if (TRACKERS.test(u.hostname)) return await route.abort();
    await assertPublicHost(u.hostname);
    return await route.continue();
  } catch {
    return route.abort('blockedbyclient').catch(() => {});
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const t = setInterval(() => {
        window.scrollBy(0, 800);
        y += 800;
        if (y >= document.body.scrollHeight || y > 20000) {
          clearInterval(t);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 80);
    });
  });
}

export async function renderWithBrowser(job, url) {
  const b = await acquire();
  let context;
  try {
    context = await b.newContext({
      userAgent: CFG.ua,
      viewport: { width: 1366, height: 900 },
      serviceWorkers: 'block',
    });
    await context.route('**/*', guard);

    const page = await context.newPage();
    const tasks = [];
    page.on('response', (resp) => {
      tasks.push((async () => {
        try {
          if (!KEEP.has(resp.request().resourceType()) || !resp.ok() || resp.status() === 206) return; // 206 = partial media
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
      mainResp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(30000, left()) });
    } catch (e) {
      if (!/timeout/i.test(String(e?.message))) throw e;
    }
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await autoScroll(page).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(300);
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
    await context?.close().catch(() => {});
    active--;
  }
}

// Top-of-page JPEG of the LIVE site (small: ~100-250 KB). Not the downloaded copy.
export async function screenshotPage(url) {
  const b = await acquire();
  let context;
  try {
    context = await b.newContext({
      userAgent: CFG.ua,
      viewport: { width: 1280, height: 800 },
      serviceWorkers: 'block',
    });
    await context.route('**/*', guard);
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (e) {
      if (!/timeout/i.test(String(e?.message))) throw e;
    }
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(400);
    return await page.screenshot({ type: 'jpeg', quality: 72 });
  } finally {
    await context?.close().catch(() => {});
    active--;
  }
}

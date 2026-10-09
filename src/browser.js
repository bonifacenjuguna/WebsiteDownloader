import { CFG, mb } from './config.js';
import { assertPublicHost } from './net.js';
import { resolveUrl } from './extract.js';
import { Semaphore } from './queue.js';
import { isTrackerUrl } from './trackers.js';
import { isChallengeHtml, isBotWallHtml } from './analyze.js';
import { notifyOnce } from './alerts.js';
import { memoryShare } from './health-util.js';

const KEEP = new Set(['stylesheet', 'script', 'image', 'font', 'media', 'manifest']);

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
    const b = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled'] });
    b.on('disconnected', () => { if (browser === b) { browser = null; crashes++; } });
    browser = b;
    served = 0;
  })().catch((e) => {
    notifyOnce('browser-launch', `⚠️ Chromium failed to start: ${e?.message || e}`);
    throw e;
  }).finally(() => { launching = null; });
  await launching;
}

let crashes = 0;

// Health numbers for /health and /stats
export const browserStats = () => ({ up: !!browser, active, served, crashes });

// Self-healing: close Chromium when the container is short on memory (only while idle), the next job starts a fresh one.
export async function recycleIfBloated() {
  if (!browser || active > 0) return false;
  const share = memoryShare();
  if (share != null && share >= CFG.memRecycleRatio) {
    const old = browser;
    browser = null;
    console.warn(`[browser] memory at ${Math.round(share * 100)}% of the container: recycling Chromium`);
    await old.close().catch(() => {});
    return true;
  }
  return false;
}

async function acquire() {
  await recycleIfBloated();
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
    if (isTrackerUrl(u.href)) return await route.abort();
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

// Second rung of the ladder: look like an ordinary visitor (no automation hints) and wait for bot checks to clear.
const STEALTH_JS = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  window.chrome = window.chrome || { runtime: {} };
  const q = window.navigator.permissions && window.navigator.permissions.query;
  if (q) window.navigator.permissions.query = (p) => (p && p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : q.call(window.navigator.permissions, p));
`;

export async function renderWithBrowser(job, url, { stealth = false } = {}) {
  const b = await acquire();
  let context;
  try {
    context = await b.newContext({
      userAgent: CFG.ua,
      viewport: { width: 1366, height: 900 },
      serviceWorkers: 'block',
      ...(stealth ? { locale: 'en-US', timezoneId: 'America/New_York', extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' } } : {}),
    });
    if (stealth) await context.addInitScript(STEALTH_JS);
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
          if (len > job.limits.maxFileBytes) {
            job.skipped.push({ url: key, reason: `larger than ${mb(job.limits.maxFileBytes)} MB`, size: len });
            return;
          }
          const buf = await resp.body();
          if (buf.length > job.limits.maxFileBytes) {
            job.skipped.push({ url: key, reason: `larger than ${mb(job.limits.maxFileBytes)} MB`, size: buf.length });
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
    await page.waitForLoadState('networkidle', { timeout: stealth ? 6000 : 4000 }).catch(() => {});
    // a bot check often clears by itself after a few seconds in a real browser
    const waitUntil = Date.now() + (stealth ? 15000 : 4000);
    let html = await page.content();
    while ((isChallengeHtml(html) || isBotWallHtml(html)) && Date.now() < waitUntil && Date.now() < job.deadline) {
      await page.waitForTimeout(1500);
      html = await page.content();
    }
    const challenge = isChallengeHtml(html) || isBotWallHtml(html);
    if (!challenge) {
      await autoScroll(page).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
      await Promise.allSettled([...tasks]);
      html = await page.content();
    }
    const originalHtml = mainResp ? await mainResp.text().catch(() => null) : null;
    return {
      html,
      challenge,
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

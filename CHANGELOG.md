# Changelog

## 1.2.1
- **Trim guard:** auto-trim never removes HTML, CSS, JS, JSON or SVG. If code alone is over Telegram's limit, the bot says so instead of sending a broken copy.
- **Retry in browser mode:** results that look nearly empty (likely JavaScript-rendered) get a hint and a 🧭 button.
- **Daily quota:** `DAILY_LIMIT` new downloads per user per UTC day (default 30, 0 = unlimited, admins exempt). Cached copies and previews are not counted.
- **Tracker stripping:** analytics/ad/session-replay scripts and pixels are no longer downloaded and are removed from the saved pages.
- **Admins made visible:** `/myid` shows your Telegram ID; admins get `/stats /ban /unban` in their command menu; non-admins get a clear message instead of silence.

## 1.2.0
- **Auto-trim:** if a site would exceed Telegram's 50 MB limit, the largest media/images are dropped (then fonts, then code) and listed in `skipped.txt`, instead of failing. Raw collection cap raised to 120 MB (`MAX_TOTAL_MB`).
- **Live progress:** status shows "Downloading assets 42/118". Status edits are now "latest wins", so they never queue up.
- **Phase timings:** fetch / browser / assets / zip / upload are stored per build; `/stats` shows 7-day averages and the share of browser-mode jobs.
- **`/browser <url>`:** force headless mode when auto-detection picks the wrong path. The result replaces the cached copy.
- **Asset retry:** one retry on 429/5xx and transient network errors.
- **Page title** in the caption and in `/history`.
- **Screenshot preview:** `/preview <url>` or the 🖼 Preview button on every result. Live-site JPEG of the top of the page, taken on demand and cached (not taken automatically, so it costs nothing unless used).
- DB migration 2 adds `title` and `timings` columns (applied automatically).

## 1.1.0
**Speed**
- One persistent Chromium (warmed at startup, recycled every 40 jobs) instead of a launch per job; up to 2 pages in parallel.
- Browser loads on `domcontentloaded` with short idle caps and a faster scroll; analytics/ad trackers are blocked.
- Telegram status edits no longer block the pipeline.
- ZIP compression level 9 -> 3; asset concurrency 8 -> 16.
- Partial (206) media responses are no longer saved as truncated files.

**Redis (optional)**
- Result cache keyed by URL: repeat requests are sent instantly by Telegram `file_id` (no rebuild, no re-upload).
- Short failure cache, per-user busy lock and cooldown. Falls back to in-memory if Redis is missing or down.

**Postgres (optional)**
- Users, download history, error codes and timings; versioned migrations run automatically on start.
- `/history` (resend past downloads instantly), "Get a fresh copy" button, admin `/stats`, `/ban`, `/unban`.
- Rows older than `RETENTION_DAYS` (default 90) are pruned daily.

**Other**
- Identical simultaneous requests share one build.
- Structured error codes for analytics.

## 1.0.0
- Initial release: fast + browser modes, SSRF protection, queue, caps, login/Cloudflare detection.

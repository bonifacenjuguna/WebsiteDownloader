# Changelog

## 1.3.0
- **`/site <url>`**, one command that detects what it is looking at:
  - **Open folder listing** ("Index of /files/"): walks the folders, downloads every file keeping the folder structure, and packs them into up to 4 Telegram-sized ZIP parts, each with a clickable `index.html`.
  - **A section of pages** (e.g. `example.com/docs`): follows same-site links under that path (default 25 pages, 2 levels deep), saves each page, and rewrites links between saved pages so they work offline. Assets are shared and downloaded once.
- Respects `robots.txt` for pages it discovers (not for the page you asked for). Skips links with query strings, non-page files and off-site links.
- Section results are cached, resendable from `/history`, multi-part aware, and have their own 🔄 Fresh copy button. One `/site` counts as one download toward the daily limit.
- Per-job limits in the engine (files, bytes, timeout), so folder listings can allow big files and long runs without loosening single-page limits.
- Tests: robots parsing, link scoping, packing, plus end-to-end runs for both modes against a mocked site.

## 1.2.3
- **Profile sync on startup:** the bot sets its own description (empty-chat "what can this bot do?" text), short description, display name and menu button through the Telegram API. It only calls Telegram when something differs, so redeploys are cheap. Disable with `PROFILE_SYNC=false`.

## 1.2.2
- Admins are exempt from the cooldown, the one-at-a-time lock, the daily quota and the preview wait.
- Admins can never be banned (including by themselves) and bypass bans and `ALLOWED_USERS`, so they can't be locked out.

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

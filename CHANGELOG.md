# Changelog

## 1.6.0 - Smarter backend, simpler UI
Principle: every decision is automatic, and people only see outcomes.

**What you asked for**
- **History can be cleared.** `/history` has a ✖ next to every entry and a 🗑 *Clear history* button with a one-tap confirmation. Cleared history is unlinked from the person; the shared copy other users get instantly is kept, with no link back to who asked.
- **`/browser` is gone** (command, 🧭 button, hints, help topic). Old 🧭 buttons in earlier chats still work and simply get a fresh copy. The backend now decides by itself, per page: plain fetch → real browser → stealth browser that waits for bot checks.

**Backend**
- **Retry ladder, per page:** pages that need JavaScript, are thin, or are refused to a plain request are rendered in the browser, the rest stay plain and keep their scripts. A thin page is only replaced when rendering really adds content.
- **Sitemap-first crawling** (`robots.txt` Sitemap lines, `sitemap.xml`, sitemap indexes, `.gz`), shallow pages first, on top of normal link following.
- **Resume after a restart:** running jobs are kept in Redis; a deploy or crash no longer leaves people on a dead progress message (needs Redis).
- **Incremental Fresh copy:** conditional requests (ETag / Last-Modified / content hash) check whether the site changed; if not, the saved copy is returned at once with no rebuild.
- **Per-host politeness:** requests to one host are spaced out, doubling on 429/503 and honouring Retry-After.
- **Duplicate-build merging:** `www.` and non-`www` are one site; simultaneous requests share one build and can no longer both become leaders.
- **Smart size budgeting:** big images are recompressed (same file name and format) before anything is left out (optional `sharp`).
- **Health:** `/health` endpoint, Chromium recycled when the container is short on memory, admins alerted when the failure rate spikes or Chromium cannot start.
- **Better failure detection:** geo-blocked sites, bot walls that survive a real browser, and pages that redirect to a sign-in are reported precisely (and sign-in pages are left out of the crawl, with a note).
- **Cancel:** every progress message has ✖ Cancel; the job stops at its next checkpoint.
- **Abuse protection:** per-user per-site and global per-site daily caps, a short pause after repeated failed attempts, and a long negative cache for sites too big to send.
- Fixed: `/stats` browser share was always 0%; a page that failed to write could break the ZIP.

**Simple UI**
- One live progress message (with a progress bar) that is edited in place, never faster than Telegram allows.
- **Links anywhere in a message** work (`check https://x.com/a, thanks`); tracking parameters (`utm_*`, `fbclid`, …) are stripped. Several links: the first is saved and you are told.
- **Result card:** ✅ site / 📝 title / 📦 pages • files • size, at most ONE note, buttons only when useful.
- **Delivery order:** several ZIPs → a summary message first, then *Part i of n*.
- **Queue position** ("You're #2 in line").
- **Languages:** English, Español, Français, Português, Deutsch, Русский, Kiswahili, chosen from your Telegram language or `/language`. Captions are stored structured, so a copy built for one person is read in everyone's own language.
- **Shorter menu:** `/start`, `/help`, `/history`, `/privacy`. `/download`, `/preview`, `/language`, `/myid` still work when typed.

**Privacy**
- `/privacy`: choose auto-delete (7 days / 30 days / never / default) and *Delete all my data* in one tap.
- Admin domain block list: `BLOCKED_DOMAINS`, `/block`, `/unblock`.

**Saved-site quality**
- More thorough rewriting: `srcset` with commas in URLs, lazy-load attributes (`data-src`, `data-bg`, …), `image-set()`, `<use>`.
- `_all-pages.html`: a local index of every saved page.
- **Link check before sending:** every local link must point to a file that is really in the ZIPs; broken ones are pointed back at the live URL.

**Housekeeping**
- Retired the unused single-page pipeline (`downloader.js`); `fetcher.js` replaces it. `trim.js` keeps only the ranking helpers.
- Tests added (`npm test`) for URLs, crawling helpers, CSS/srcset rewriting, translations and captions.
- Database migration 3 (adds per-user language and retention, an anonymous owner for cleared history, and the block list). Run once automatically.
- New optional dependency: `sharp`. New environment variables are listed in `.env.example`.

## 1.5.0 - Whole-site downloads (one command, several ZIPs)
- **Every link now saves the whole site**, not just one page. `example.com` crawls every reachable page; `example.com/docs` crawls that part. `/site` is gone from the menu and help (kept as a hidden alias).
- **Locally wired:** pages saved as `folder/index.html`; links between pages, assets and linked documents (PDF, zip, office files, audio/video) point to relative paths.
- **Multi-part ZIPs (~40 MB each, up to 12):** unzip them all into the same folder. Part 1 has `index.html`, `README.txt`, `skipped.txt`. Code and pages are packed first; if parts run out only media/images/documents are dropped. A part that lands over Telegram's limit is split automatically.
- **Bigger files:** `MAX_FILE_MB` 10 -> 42. Big downloads are limited to 2 at a time to protect memory.
- **JavaScript-built sites** are crawled page by page in Chromium (cap `SITE_MAX_PAGES_BROWSER`, 60) instead of being refused.
- **Folder listings** are still detected automatically.
- New defaults: `SITE_MAX_PAGES` 300, `SITE_DEPTH` 10, `SITE_MAX_PARTS` 12, `SITE_MAX_TOTAL_MB` 500, `SITE_TIMEOUT_SEC` 480. New `PART_MB` (40), `SITE_MAX_PAGES_BROWSER`.
- Per-user busy lock now lasts 30 min (long crawls plus several uploads).
- Whole-site results use their own cache key, so old single-page cache entries are not served.

## 1.4.0 - UX refinement (no backend capability removed)
Principle: complexity stays in the backend, clarity goes in the UI.
- **One place for wording:** all user-facing text now lives in `src/copy.js` (plus `help.js` and `profile.js`). The backend still raises precise error codes and technical messages, which go to the logs and database; the UI translates them into short, human language. Edit `copy.js` to change any message.
- **Cleaner results:** `✅ domain / 📝 title / 📦 files • size`, plus at most two short notes. Implementation labels ("fast mode") and the unzip instruction were dropped from results (the unzip steps are in /start, /help and the README inside every ZIP).
- **Friendlier notes:** e.g. "This site loads much of its content after opening. Try browser mode for a closer copy." A couple of missing images is no longer reported; it is only mentioned when it is a meaningful share.
- **Progressive disclosure:** buttons depend on the result. Fresh static site: 🖼 Preview. Dynamic site: 🧭 Browser mode + 🖼 Preview. Saved copy: 🔄 Fresh copy + 🖼 Preview.
- **Failures offer one useful action, not diagnostics:** temporary problems get 🔁 Try again; a dynamic site that can't be saved as a section gets 🧭 Browser mode; permanent problems (not found, protected, sign-in) just explain. A failed attempt no longer starts the cooldown, so Try again works immediately.
- **Human error messages** for every error code (not found, blocked, protected, rate limited, slow, certificate, sign-in, and more) with no HTTP codes or tool names.
- **New /start** (a short product introduction), a **"What I can do"** menu grouped by what you can accomplish, rewritten help topics, status messages ("Opening…", "Collecting files… 42/118", "Packing your ZIP…"), and new bot description and short description.
- Saved copies now show "⚡ Instant copy · saved 3h ago"; a result someone else just built looks like a normal fresh one.
- Tests added: every backend error code has a human message; a vocabulary check keeps technical terms out of user-facing text; caption, button and failure-action rules.

## 1.3.1
- **Interactive `/help`:** a menu of topic buttons (Download, Sections & folders, Browser mode, Previews, History, Limits, Troubleshooting, plus Admin for admins). Tapping a topic swaps the message in place; ◀ ▶ page through; 🏠 returns to the menu; ✖ closes it. Numbers (limits, caps, cache hours) are read from your config, so the help always matches the bot's real settings.
- `/start` now shows a 📖 Help & guides button; `/help` added to the command menu.

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

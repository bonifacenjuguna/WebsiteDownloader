# Website Downloader (@WebsiteDownloaderBot) v1.6.0

Telegram bot (Node.js + Telegraf) that turns any website into an offline copy: every page, image and file, linked locally.
Send `example.com` (or a message that contains a link) -> get one or more ZIPs -> unzip ALL of them into the same folder -> open `index.html`.

Design rule: **advanced backend, simple UI.** Every decision (browser or not, stealth, retries, compression, resuming) is automatic; people only see outcomes.

## Deploy on Railway
1. Push this folder to a GitHub repo and create a Railway project from it (the `Dockerfile` is detected automatically).
2. In the same project click **+ New -> Database -> PostgreSQL**, then again for **Redis**.
3. On the bot service, add variables:
   - `BOT_TOKEN` = token from @BotFather
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `REDIS_URL` = `${{Redis.REDIS_URL}}`
   - `ADMIN_IDS` = your Telegram numeric ID (enables /stats, /ban, /unban, /block, /unblock)
4. Give the bot service at least 1 GB RAM (Chromium needs it) and run only ONE instance (long polling).
5. Optional: set the service health check path to `/health`.
6. Deploy. Tables are created automatically on first start. Logs show `Postgres: connected` and `Redis: connected`.

Postgres and Redis are optional: without them the bot still works (in-memory cache/limits, no history, no resume after restart).

## Redis vs Postgres
- **Redis (disposable):** result cache, failure cache, per-user lock and cooldown, daily counters, change fingerprints, jobs in flight (for resume).
- **Postgres (durable):** users (language, auto-delete choice), download history, Telegram `file_id`s (so a Redis flush doesn't lose the cache), analytics, admin block list.
- Cached results are shared between users: the bot never sends cookies or credentials, so everyone gets the same public copy. Default freshness is 6 hours (`CACHE_TTL_MIN`).
- Privacy: requested URLs are stored with the user's Telegram ID for `RETENTION_DAYS` (default 90), or for the time the person chose in `/privacy`.

## How it works
- **Fast path first:** plain fetch + cheerio. Pages that need JavaScript, look empty, or are refused to a plain request are rendered in Chromium, **per page**. Browser pages are saved as snapshots (scripts removed, so they open with a double-click); plain pages keep their scripts.
- **Retry ladder:** plain fetch -> real browser -> stealthier browser that waits for bot checks to clear. The person sees one result.
- **Sitemap-first discovery** on top of link following, shallow pages first.
- Links are rewritten to relative paths; anything not saved keeps its online URL. `srcset`, lazy-load attributes, CSS `url()`, `@import` and `image-set()` are handled.
- **Before sending:** big images are recompressed if the site would not fit (optional `sharp`), and every local link is checked against what is really in the ZIPs. `_all-pages.html` lists every saved page.
- **Fresh copy is incremental:** the site is asked (ETag / Last-Modified / content hash) whether anything changed; if not, the saved copy is returned at once.
- **Resume:** jobs in flight are kept in Redis; after a deploy or crash they continue instead of leaving a dead progress message.
- **Politeness:** per-host request spacing that backs off on 429/503.
- Files over `MAX_FILE_MB` (42), or beyond the ZIP part budget, are skipped and listed in `skipped.txt`.
- Precise failures: not found, protected (even through a real browser), region-blocked, sign-in, DNS, SSL, timeouts, and more, each with a short human message.

## Commands
Menu: `/start` `/help` `/history` `/privacy`. Also work when typed: `/download <url>`, `/preview <url>`, `/language`, `/myid`.
Admins: `/stats`, `/ban <id>`, `/unban <id>`, `/block <domain>`, `/unblock <domain>`, `/block` (list).

- Any message containing a link works. Tracking parameters (`utm_*`, `fbclid`, ...) are removed. With several links the first is saved.
- `/history`: tap to resend, ✖ to remove one, 🗑 to clear all. `/privacy`: auto-delete (7 days / 30 days / never / default) and delete all your data.
- `/preview` sends a screenshot of the **live** site (top of page). Every result also has a 🖼 Preview button.
- Every progress message has ✖ Cancel.
- `/language`: English, Español, Français, Português, Deutsch, Русский, Kiswahili. Default: the person's Telegram language.
- There is no `/browser` command: browser use is decided automatically.

## Health and alerts
- `GET /health` (on `$PORT`) returns queue, Redis/Postgres state, browser stats and memory. Set `HEALTH=false` to disable.
- Chromium is recycled when the container uses more than `BROWSER_MEM_RATIO` (0.85) of its memory limit (only while idle).
- Admins get a message when the failure rate of the bot's own jobs spikes, or when Chromium cannot start (at most once an hour per topic).

## Safety and abuse protection
- SSRF protection: private/internal IPs and hostnames blocked, checked on every redirect and every browser request.
- One job per user, cooldown, queue with a waiting cap, size/file/time caps, temp folders deleted after each job.
- `DOMAIN_DAILY_CAP` (new builds of one site per user per day) and `DOMAIN_GLOBAL_DAILY` (all users), `FAIL_STRIKES` / `FAIL_PAUSE_MIN` (a short pause after repeated failed attempts). Sites too big to send are remembered for 6 hours.
- `BLOCKED_DOMAINS` and `/block` stop specific sites (subdomains included).
- Set `ALLOWED_USERS` to restrict the bot to specific Telegram IDs.

## Local run
```
npm install
npx playwright install chromium
BOT_TOKEN=xxx npm start
npm test
```

## Admins
There is no admin screen. An admin is a Telegram user ID listed in the `ADMIN_IDS` variable.
1. Send `/myid` to the bot to get your ID.
2. Set `ADMIN_IDS=<your id>` (comma-separate several) and redeploy.
3. Admins get `/stats`, `/ban`, `/unban`, `/block`, `/unblock` in their command menu, and are exempt from the cooldown, the one-at-a-time lock, `DAILY_LIMIT`, domain caps, bans and `ALLOWED_USERS`. Admins cannot be banned.

## Whole-site crawl (the default for every link)
- `example.com` saves the whole site. `example.com/docs` saves that part of the site only.
- **Pages:** same host, breadth-first, up to `SITE_MAX_PAGES` (300) and `SITE_DEPTH` (10); sites that build pages with JavaScript are capped at `SITE_MAX_PAGES_BROWSER` (60). Disallowed paths in `robots.txt` are skipped (`SITE_RESPECT_ROBOTS=false` turns that off). Links with `?query` are not followed. Pages that redirect to a sign-in are left out.
- **ZIP parts:** about `PART_MB` (40) MB each, at most `SITE_MAX_PARTS` (12). Every path is relative to one shared root, so unzipping all parts into the same folder gives a working site. Part 1 holds `index.html`, `README.txt`, `_all-pages.html` and `skipped.txt`. With several parts the bot first sends a summary message, then *Part i of n*.
- **When it does not fit:** images are recompressed first; then code and pages are packed first and the largest videos/images/documents are left out (listed in `skipped.txt`, still loading from the live site online).
- **Folder listings:** an "Index of" page is detected automatically and downloaded as files (`SITE_MAX_FILES`, `SITE_MAX_DIRS`, `SITE_MAX_TOTAL_MB`), keeping the folder structure.
- Time limit `SITE_TIMEOUT_SEC` (480). One link counts as one download toward `DAILY_LIMIT`.

## Editing the wording
Everything users read is in `src/copy.js` (English: start text, progress, captions, notes, errors, small messages, buttons), `src/locales/*.js` (translations; any missing key falls back to English), `src/help.js` (the /help guides, English) and `src/profile.js` (the bot's Telegram description). The backend keeps precise error codes and technical details in logs and the database, so you can reword freely. To add a language: create `src/locales/xx.js`, register it in `src/locales/index.js` and `LANGS` in `copy.js`; `npm test` checks the keys.

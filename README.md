# Website Downloader (@WebsiteDownloaderBot) v1.3.0

Telegram bot (Node.js + Telegraf) that turns any website into an offline ZIP.
Send `example.com` (any format) -> get a ZIP -> unzip -> open `index.html`.

## Deploy on Railway
1. Push this folder to a GitHub repo and create a Railway project from it (the `Dockerfile` is detected automatically).
2. In the same project click **+ New -> Database -> PostgreSQL**, then again for **Redis**.
3. On the bot service, add variables:
   - `BOT_TOKEN` = token from @BotFather
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `REDIS_URL` = `${{Redis.REDIS_URL}}`
   - `ADMIN_IDS` = your Telegram numeric ID (enables /stats, /ban, /unban)
4. Give the bot service at least 1 GB RAM (Chromium needs it) and run only ONE instance (long polling).
5. Deploy. Tables are created automatically on first start. Logs show `Postgres: connected` and `Redis: connected`.

Postgres and Redis are optional: without them the bot still works (in-memory cache/limits, no history).

## Redis vs Postgres
- **Redis (disposable):** result cache, failure cache, per-user lock and cooldown.
- **Postgres (durable):** users, download history, Telegram `file_id`s (so a Redis flush doesn't lose the cache), analytics.
- Cached results are shared between users: the bot never sends cookies or credentials, so everyone gets the same public copy. Default freshness is 6 hours (`CACHE_TTL_MIN`); users can tap **Get a fresh copy**.
- Privacy: requested URLs are stored with the user's Telegram ID for `RETENTION_DAYS` (default 90).

## How it works
- Fast path: fetch + cheerio for normal sites.
- Browser path (Playwright/Chromium) for JS-rendered sites and Cloudflare-style pages. Saves every loaded response, scrolls to trigger lazy images.
- Links are rewritten to relative paths; anything not downloaded keeps its online URL.
- Browser mode outputs `index.html` (rendered snapshot, scripts removed) and `index.original.html` (original scripts, needs `npx serve`).
- Files over `MAX_FILE_MB`, or beyond the ZIP budget, are skipped and listed in `skipped.txt`.
- Login/Cloudflare/403/404/5xx/DNS/SSL problems produce a clear message; login pages are still saved.

## Commands
`/start` `/help` `/history` `/download <url>` `/site <url>` `/preview <url>` `/browser <url>` and, for admins, `/stats` `/ban <id>` `/unban <id>`.

- `/preview` sends a screenshot of the **live** site (top of page), cached for `CACHE_TTL_MIN`. Every result also has a 🖼 Preview button.
- `/browser` forces headless mode and bypasses the cache; use it when a JS-heavy site came out empty.
- If a site is too big for Telegram, the largest media/images are left out automatically and listed in `skipped.txt`.

## Safety
- SSRF protection: private/internal IPs and hostnames blocked, checked on every redirect and every browser request.
- One job per user, cooldown, queue with a waiting cap, size/file/time caps, temp folders deleted after each job.
- Set `ALLOWED_USERS` to restrict the bot to specific Telegram IDs.

## Local run
```
npm install
npx playwright install chromium
BOT_TOKEN=xxx npm start
```

## Admins
There is no admin screen. An admin is a Telegram user ID listed in the `ADMIN_IDS` variable.
1. Send `/myid` to the bot to get your ID.
2. Set `ADMIN_IDS=<your id>` (comma-separate several) and redeploy.
3. Admins get `/stats` (usage, speed, errors), `/ban <id>`, `/unban <id>` in their command menu, and are exempt from the cooldown, the one-at-a-time lock, `DAILY_LIMIT`, bans and `ALLOWED_USERS`. Admins cannot be banned.

## Limits and safety knobs
`DAILY_LIMIT` (new downloads per user per day), `COOLDOWN_SEC`, `MAX_FILE_MB`, `MAX_TOTAL_MB`, `JOB_TIMEOUT_SEC`. Analytics/ad trackers are never downloaded and are stripped from saved pages. Auto-trim only ever drops media, images and fonts, never code.

## Bot profile (auto-managed)
On every start the bot makes sure its Telegram profile matches the code: description, short description, name (`BOT_NAME`) and the menu button. Edit the texts in `src/profile.js`. Set `PROFILE_SYNC=false` to manage them yourself in @BotFather. Only the profile picture and privacy settings still need @BotFather.

## /site (sections and folder listings)
`/site example.com/docs` saves a whole section. `/site example.com/files/` on an open "Index of" listing downloads the files.
- **Pages:** same host only, inside the section path, up to `SITE_MAX_PAGES` (25) and `SITE_DEPTH` (2) levels. Links between saved pages work offline; everything else opens the live site. Links with `?query` and non-page files (PDF, images) are not followed. Needs server-rendered pages: JavaScript-built sites are refused with a hint to use `/browser`. Disallowed paths in `robots.txt` are skipped (turn off with `SITE_RESPECT_ROBOTS=false`).
- **Folder listings:** up to `SITE_MAX_FILES` (300) files in `SITE_MAX_DIRS` (60) folders, `SITE_MAX_TOTAL_MB` (200) total, split into at most `SITE_MAX_PARTS` (4) ZIPs of about 43 MB. Files over ~43 MB cannot be sent by Telegram and are listed in `skipped.txt`. Unzip all parts into one folder.
- Time limit `SITE_TIMEOUT_SEC` (300). Anything left out is listed in `skipped.txt` and flagged in the caption.

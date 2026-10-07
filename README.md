# Website Downloader (@WebsiteDownloaderBot) v1.5.0

Telegram bot (Node.js + Telegraf) that turns any website into an offline copy: every page, image and file, linked locally.
Send `example.com` (any format) -> get one or more ZIPs -> unzip ALL of them into the same folder -> open `index.html`.

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
- Files over `MAX_FILE_MB` (42), or beyond the ZIP part budget, are skipped and listed in `skipped.txt`.
- Login/Cloudflare/403/404/5xx/DNS/SSL problems produce a clear message; login pages are still saved.

## Commands
`/start` `/help` (interactive guides) `/history` `/download <url>` `/preview <url>` `/browser <url>` and, for admins, `/stats` `/ban <id>` `/unban <id>`.

- `/preview` sends a screenshot of the **live** site (top of page), cached for `CACHE_TTL_MIN`. Every result also has a 🖼 Preview button.
- `/browser` forces headless mode and bypasses the cache; use it when a JS-heavy site came out empty.
- If a site is too big for Telegram, it is split into several ZIPs; beyond the part limit the largest media/images are left out and listed in `skipped.txt`.

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
`DAILY_LIMIT` (new downloads per user per day), `COOLDOWN_SEC`, `MAX_FILE_MB`, `PART_MB`, `SITE_*`. Analytics/ad trackers are never downloaded and are stripped from saved pages. Auto-trim only ever drops media, images and fonts, never code.

## Bot profile (auto-managed)
On every start the bot makes sure its Telegram profile matches the code: description, short description, name (`BOT_NAME`) and the menu button. Edit the texts in `src/profile.js`. Set `PROFILE_SYNC=false` to manage them yourself in @BotFather. Only the profile picture and privacy settings still need @BotFather.

## Whole-site crawl (the default for every link)
There is no `/site` command any more (it still works as a hidden alias). Every link is crawled:
- `example.com` saves the whole site. `example.com/docs` saves that part of the site only.
- **Pages:** same host, breadth-first, up to `SITE_MAX_PAGES` (300) and `SITE_DEPTH` (10). JavaScript-built sites are crawled in headless Chromium, capped at `SITE_MAX_PAGES_BROWSER` (60). Disallowed paths in `robots.txt` are skipped (`SITE_RESPECT_ROBOTS=false` turns that off). Links with `?query` are not followed.
- **Local wiring:** pages are saved as `folder/index.html`; links between pages, images, styles and linked documents (PDF, zip, office files, audio/video) are rewritten to relative paths. Anything not saved keeps its live URL.
- **ZIP parts:** output is packed into parts of about `PART_MB` (40) MB, at most `SITE_MAX_PARTS` (12). Single files up to `MAX_FILE_MB` (42) are allowed and get a part of their own if needed. Every path is relative to one shared root, so unzipping all parts into the same folder gives a working site. Part 1 holds `index.html`, `README.txt` and `skipped.txt`.
- **When it does not fit:** code and pages are packed first; if parts run out, the largest videos/images/documents are left out (listed in `skipped.txt`, still loading from the live site online).
- **Folder listings:** an "Index of" page is detected automatically and downloaded as files (`SITE_MAX_FILES`, `SITE_MAX_DIRS`, `SITE_MAX_TOTAL_MB`), keeping the folder structure.
- Time limit `SITE_TIMEOUT_SEC` (480). One link counts as one download toward `DAILY_LIMIT`.

## Editing the wording
Everything users read is in `src/copy.js` (start text, progress messages, result captions, notes, errors, small messages and button rules), `src/help.js` (the /help guides) and `src/profile.js` (the bot's Telegram description). The backend keeps the precise error codes and technical details in logs and the database, so you can reword freely without losing diagnostics.

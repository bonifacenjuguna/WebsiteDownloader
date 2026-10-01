# Website Downloader (@WebsiteDownloaderBot)

Telegram bot (Node.js + Telegraf) that turns any website into an offline ZIP.
Send `example.com` (any format) -> get a ZIP -> unzip -> open `index.html`.

## Deploy on Railway
1. Push this folder to a GitHub repo and create a Railway project from it (the `Dockerfile` is detected automatically).
2. Add variable `BOT_TOKEN` (from @BotFather). Optional variables are in `.env.example`.
3. Give the service at least 1 GB RAM (Chromium needs it).
4. Run only ONE instance (long polling).

## How it works
- Fast path: fetch + cheerio for normal sites.
- Browser path (Playwright/Chromium) for JS-rendered sites and Cloudflare-style pages. Saves every loaded response, scrolls to trigger lazy images.
- Links are rewritten to relative paths; anything not downloaded keeps its online URL.
- Browser mode outputs `index.html` (rendered snapshot, scripts removed) and `index.original.html` (original scripts, needs `npx serve`).
- Files over `MAX_FILE_MB`, or beyond the ZIP budget, are skipped and listed in `skipped.txt`.
- Login/Cloudflare/403/404/5xx/DNS/SSL problems produce a clear message; login pages are still saved.

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

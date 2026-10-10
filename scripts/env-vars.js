// The single source of truth for configuration. `npm run env` turns this list into `.env`, `.env.example` and the
// table in README.md, and `npm test` fails if the code reads a variable that is missing here or if a default drifts.
// `value` is exactly what the bot uses when the variable is not set (blank = off / not set).
export const GROUPS = [
  ['connect', 'Connections and identity', 'Only BOT_TOKEN is required. Add DATABASE_URL, REDIS_URL and ADMIN_IDS for the full feature set.'],
  ['users', 'People and limits', 'Who may use the bot and how much.'],
  ['site', 'Crawling a site', 'How much of a site is saved.'],
  ['zip', 'Files and ZIPs', 'Telegram upload sizes and per-file limits.'],
  ['speed', 'Speed', 'Downloads, caching and size budgeting.'],
  ['cache', 'Caching and history', 'How long things are remembered.'],
  ['browser', 'Chromium (dynamic and protected sites)', 'Used automatically when a plain fetch is not enough.'],
  ['resources', 'Memory and disk protection', 'Keeps a small instance from running out of room.'],
  ['reliable', 'Restarts, deploys and big files', 'Resume, webhook mode and the self-hosted Bot API.'],
  ['observe', 'Health, metrics and logs', 'Watching the bot.'],
];

export const VARS = [
  // connect
  ['connect', 'BOT_TOKEN', '', 'REQUIRED. The token from @BotFather.'],
  ['connect', 'DATABASE_URL', '', 'Postgres connection string (Railway: ${{Postgres.DATABASE_URL}}). Enables history, analytics and a durable cache.'],
  ['connect', 'REDIS_URL', '', 'Redis connection string (Railway: ${{Redis.REDIS_URL}}). Enables the fast cache, locks, limits and resume after restarts.'],
  ['connect', 'PGSSL', 'false', 'Set true if your Postgres requires SSL.'],
  ['connect', 'ADMIN_IDS', '', 'Your Telegram numeric ID (send /myid to the bot). Comma-separate several. Enables /ping, /stats, /ban, /block and admin notices.'],
  ['connect', 'ADMIN_NOTIFY', 'true', 'DM admins when the bot starts and shuts down.'],
  ['connect', 'ALLOWED_USERS', '', 'Comma-separated Telegram IDs allowed to use the bot. Blank = everyone.'],
  ['connect', 'BOT_NAME', 'Website Downloader', "The bot's display name (kept in sync on start)."],
  ['connect', 'PROFILE_SYNC', 'true', "Keep the bot's Telegram profile (description, menu button) in sync on every start."],
  // users
  ['users', 'DAILY_LIMIT', '30', 'New (non-cached) downloads per user per day, UTC. 0 = unlimited. Admins are exempt.'],
  ['users', 'COOLDOWN_SEC', '20', 'Seconds a user must wait between downloads.'],
  ['users', 'DOMAIN_DAILY_CAP', '5', 'New builds of ONE site per user per day. 0 = unlimited.'],
  ['users', 'DOMAIN_GLOBAL_DAILY', '60', 'New builds of ONE site per day across all users. 0 = unlimited.'],
  ['users', 'FAIL_STRIKES', '8', 'Failed attempts per hour before a short pause for that user.'],
  ['users', 'FAIL_PAUSE_MIN', '15', 'Length of that pause, in minutes.'],
  ['users', 'BLOCKED_DOMAINS', '', 'Comma-separated sites nobody can download (subdomains included). Admins can also use /block.'],
  ['users', 'QUEUE_CONCURRENCY', '2', 'Jobs running at once.'],
  ['users', 'QUEUE_MAX_WAITING', '10', 'Jobs allowed to wait; more get "I\'m busy".'],
  // site
  ['site', 'SITE_MAX_PAGES', '300', 'Maximum pages saved per site.'],
  ['site', 'SITE_MAX_PAGES_BROWSER', '60', 'Maximum pages for sites that build every page with JavaScript (each needs a browser load).'],
  ['site', 'SITE_DEPTH', '10', 'How many link-clicks deep the crawl goes.'],
  ['site', 'SITE_MAX_FILES', '300', 'Folder listings: files to download. Whole sites: linked documents.'],
  ['site', 'SITE_MAX_DIRS', '60', 'Folder listings: folders to walk.'],
  ['site', 'SITE_MAX_TOTAL_MB', '500', 'Total size of one site before things are left out.'],
  ['site', 'SITE_MAX_PARTS', '12', 'Maximum ZIP parts for one site.'],
  ['site', 'SITE_TIMEOUT_SEC', '480', 'Time limit for one site.'],
  ['site', 'SITE_RESPECT_ROBOTS', 'true', 'Skip pages that robots.txt asks bots not to copy. Set false to copy them.'],
  ['site', 'SITE_SITEMAP', 'true', 'Read sitemap.xml to find pages.'],
  ['site', 'SITE_SITEMAP_URLS', '1000', 'Most URLs taken from a sitemap.'],
  // zip
  ['zip', 'PART_MB', '40', 'Target size of each ZIP part (Telegram allows 50 MB; with a self-hosted Bot API the default becomes 1500).'],
  ['zip', 'MAX_FILE_MB', '42', 'Largest single file saved (with a self-hosted Bot API the default becomes 150).'],
  ['zip', 'MAX_TOTAL_MB', '120', 'Default size cap for a single job when a caller does not set its own.'],
  ['zip', 'MAX_FILES', '1500', 'Default file-count cap for a single job when a caller does not set its own.'],
  ['zip', 'JOB_TIMEOUT_SEC', '150', 'Default time cap for a single job when a caller does not set its own.'],
  // speed
  ['speed', 'ASSET_CONCURRENCY', '24', 'Files downloaded at once.'],
  ['speed', 'PAGE_CONCURRENCY', '8', 'Pages of a crawl fetched at once.'],
  ['speed', 'HOST_MAX_CONCURRENT', '8', 'Simultaneous requests to one host (halves automatically when a site pushes back).'],
  ['speed', 'HOST_GAP_MS', '8', 'Minimum gap between requests to one host, in ms (grows automatically on 429/503).'],
  ['speed', 'ASSET_STALL_SEC', '10', 'Give up on a file when no data arrives for this many seconds.'],
  ['speed', 'SHARED_CACHE_MB', '256', 'Size of the shared cache for popular library and font files. 0 = off.'],
  ['speed', 'IMAGE_COMPRESS', 'true', 'Shrink big images before leaving anything out (needs the optional sharp package).'],
  ['speed', 'LINK_CHECK', 'true', 'Verify every local link before sending; broken ones point back to the live site.'],
  // cache
  ['cache', 'CACHE_TTL_MIN', '1440', 'Minutes a saved copy is sent as-is.'],
  ['cache', 'STALE_MAX_DAYS', '7', 'Copies up to this old are re-checked with the site and re-sent when nothing changed.'],
  ['cache', 'NEG_CACHE_SEC', '300', 'Seconds a failure is remembered, so the same dead link is not retried at once.'],
  ['cache', 'RETENTION_DAYS', '90', 'Days history is kept (people can choose 7, 30 or never with /privacy).'],
  // browser
  ['browser', 'ENABLE_BROWSER', 'true', 'Use Chromium when needed. false = plain fetching only.'],
  ['browser', 'BROWSER_CONCURRENCY', '1', 'Pages rendered by Chromium at once.'],
  ['browser', 'BROWSER_IDLE_MIN', '5', 'Close Chromium after this many idle minutes (it starts again on demand).'],
  ['browser', 'BROWSER_WARM', 'false', 'true = keep Chromium running from startup (uses about 300 MB).'],
  ['browser', 'BROWSER_RECYCLE_AFTER', '40', 'Restart Chromium after this many jobs to keep memory flat.'],
  ['browser', 'BROWSER_MEM_RATIO', '0.85', 'Restart an idle Chromium when the container uses more than this share of its memory.'],
  // resources
  ['resources', 'MEM_ADMIT_RATIO', '0.92', 'An extra parallel job waits while the container is above this share of memory.'],
  ['resources', 'DISK_MIN_MB', '700', 'An extra parallel job waits while the temp disk has less free space than this. 0 = off.'],
  // reliable
  ['reliable', 'RESUME', 'true', 'Continue unfinished jobs after a restart (needs Redis).'],
  ['reliable', 'RESUME_MAX_MIN', '30', 'Oldest interrupted job, in minutes, that is still resumed.'],
  ['reliable', 'DRAIN_SECONDS', '8', 'On shutdown, wait this long for running jobs to finish.'],
  ['reliable', 'WEBHOOK_DOMAIN', '', 'Public host of this service (no https://) to receive updates by webhook, so deploys lose no messages. Blank = polling.'],
  ['reliable', 'TELEGRAM_API_URL', '', 'Self-hosted Telegram Bot API server URL. Lifts the 50 MB upload limit to 2 GB.'],
  // observe
  ['observe', 'HEALTH', 'true', 'Serve GET /health. false = no web server unless webhook mode needs it.'],
  ['observe', 'HEALTH_PORT', '', 'Port for the web server when Railway\'s PORT is not set (local use).'],
  ['observe', 'METRICS_TOKEN', '', 'Enables GET /metrics (Prometheus). Send it as "Authorization: Bearer <token>".'],
  ['observe', 'LOG_FORMAT', '', 'json = one JSON object per log event. Blank = readable lines.'],
];

// Variables the platform sets for us; they are read by the code but must not be in .env
export const PLATFORM_VARS = new Set(['PORT']);

const HEADER = `# Website Downloader configuration.
# Generated by "npm run env" from scripts/env-vars.js. Edit that file, not this one.
#
# Every value below is the bot's built-in default, so the bot behaves the same with this file or without it.
# Change only what you need.
#   Railway: Variables -> Raw Editor -> paste only the lines you want to change.
#   Local:   npm run dev   (reads this file)
# Blank means "off / not set". Never commit real secrets: .env is in .gitignore and .dockerignore.
`;

export function renderEnv() {
  const out = [HEADER];
  for (const [id, title, blurb] of GROUPS) {
    out.push(`# ---------- ${title} ----------`, `# ${blurb}`);
    for (const [g, name, value, doc] of VARS) {
      if (g !== id) continue;
      out.push(`# ${doc}`, `${name}=${value}`);
    }
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

const cell = (s) => String(s).replace(/\|/g, '\\|');
export function renderTable() {
  const out = [];
  for (const [id, title, blurb] of GROUPS) {
    out.push(`#### ${title}`, '', blurb, '', '| Variable | Default | What it does |', '|---|---|---|');
    for (const [g, name, value, doc] of VARS) {
      if (g !== id) continue;
      out.push(`| \`${name}\` | ${value === '' ? '*(blank)*' : `\`${cell(value)}\``} | ${cell(doc)} |`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

export const TABLE_START = '<!-- ENV-TABLE:START (generated by npm run env) -->';
export const TABLE_END = '<!-- ENV-TABLE:END -->';

const num = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
// like num(), but 0 is a valid value (usually "off" / "unlimited")
const numZ = (k, d) => {
  const raw = process.env[k];
  if (raw === undefined || raw === '') return d;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : d;
};
// with a self-hosted Telegram Bot API server the 50 MB upload cap becomes 2 GB: bigger parts, fewer ZIPs
const BIG_API = !!process.env.TELEGRAM_API_URL;
const list = (k) => (process.env[k] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
export const MB = 1024 * 1024;
export const mb = (n) => (n / MB).toFixed(1);

export const CFG = {
  token: process.env.BOT_TOKEN,
  allowedUsers: (process.env.ALLOWED_USERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  enableBrowser: process.env.ENABLE_BROWSER !== 'false',
  maxFileBytes: num('MAX_FILE_MB', BIG_API ? 150 : 42) * MB,   // single files up to 42 MB (Telegram's hard cap is 50 MB; 150 MB is the memory-safe limit with a local Bot API)
  partBytes: num('PART_MB', BIG_API ? 1500 : 40) * MB,          // target size of each ZIP part sent to Telegram
  maxTotalBytes: num('MAX_TOTAL_MB', 120) * MB,
  maxHtmlBytes: 8 * MB,
  maxFiles: num('MAX_FILES', 1500),
  jobTimeoutMs: num('JOB_TIMEOUT_SEC', 150) * 1000,
  fetchTimeoutMs: 15000,
  assetConcurrency: num('ASSET_CONCURRENCY', 24),   // files downloaded at once (per-host caps still apply)
  pageConcurrency: num('PAGE_CONCURRENCY', 8),     // pages of a crawl fetched at once
  stallMs: num('ASSET_STALL_SEC', 10) * 1000,       // give up on a file when no bytes arrive for this long
  queueConcurrency: num('QUEUE_CONCURRENCY', 2),
  queueMaxWaiting: num('QUEUE_MAX_WAITING', 10),
  cooldownMs: num('COOLDOWN_SEC', 20) * 1000,
  databaseUrl: process.env.DATABASE_URL || '',
  pgSsl: process.env.PGSSL === 'true',
  redisUrl: process.env.REDIS_URL || '',
  adminIds: (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  cacheTtlMs: num('CACHE_TTL_MIN', 1440) * 60 * 1000,   // a saved copy is sent as-is for this long
  staleMaxDays: num('STALE_MAX_DAYS', 7),                // older copies are re-checked with the site and reused when nothing changed
  negTtlMs: num('NEG_CACHE_SEC', 300) * 1000,
  retentionDays: num('RETENTION_DAYS', 90),
  // new (non-cached) downloads per user per UTC day; 0 = unlimited; admins are exempt
  dailyLimit: process.env.DAILY_LIMIT !== undefined && process.env.DAILY_LIMIT !== '' && Number(process.env.DAILY_LIMIT) >= 0 ? Number(process.env.DAILY_LIMIT) : 30,
  // keep the bot's Telegram profile (description, short description, name, menu button) in sync on every start
  profileSync: process.env.PROFILE_SYNC !== 'false',
  botName: process.env.BOT_NAME || 'Website Downloader',
  // /site: whole-section and folder-listing downloads
  siteMaxPages: num('SITE_MAX_PAGES', 300),
  siteMaxPagesBrowser: num('SITE_MAX_PAGES_BROWSER', 60), // JS-rendered sites: each page needs a real browser load
  siteDepth: num('SITE_DEPTH', 10),
  siteMaxFiles: num('SITE_MAX_FILES', 300),   // folder listings: files; whole sites: linked documents
  siteMaxDirs: num('SITE_MAX_DIRS', 60),
  siteMaxTotalBytes: num('SITE_MAX_TOTAL_MB', BIG_API ? 1200 : 500) * MB,
  siteMaxParts: num('SITE_MAX_PARTS', 12),
  siteTimeoutMs: num('SITE_TIMEOUT_SEC', 480) * 1000,
  siteRespectRobots: process.env.SITE_RESPECT_ROBOTS !== 'false',
  browserConcurrency: num('BROWSER_CONCURRENCY', 1),
  browserIdleMs: num('BROWSER_IDLE_MIN', 5) * 60 * 1000,   // Chromium is closed after this long without work (it starts again on demand)
  browserWarm: process.env.BROWSER_WARM === 'true',        // keep Chromium running from startup (uses ~300 MB)
  // v1.6: automatic behaviour (no user-facing switches)
  siteSitemap: process.env.SITE_SITEMAP !== 'false',          // read sitemap.xml to find pages faster
  siteSitemapMax: num('SITE_SITEMAP_URLS', 1000),
  hostGapMs: num('HOST_GAP_MS', 8),                          // minimum gap between requests to one host (adapts on 429/503)
  compressImages: process.env.IMAGE_COMPRESS !== 'false',     // shrink images before leaving them out (needs the optional sharp package)
  linkCheck: process.env.LINK_CHECK !== 'false',              // verify local links before sending
  resume: process.env.RESUME !== 'false',                     // continue unfinished jobs after a restart (needs Redis)
  resumeMaxAgeMs: num('RESUME_MAX_MIN', 30) * 60 * 1000,
  domainDailyCap: numZ('DOMAIN_DAILY_CAP', 5),                // new builds of one site per user per day (0 = unlimited)
  domainGlobalDaily: numZ('DOMAIN_GLOBAL_DAILY', 60),         // new builds of one site per day, all users (0 = unlimited)
  failStrikes: num('FAIL_STRIKES', 8),                        // failed attempts per hour before a short pause
  failPauseMs: num('FAIL_PAUSE_MIN', 15) * 60 * 1000,
  blockedDomains: list('BLOCKED_DOMAINS'),
  hostMaxConcurrent: num('HOST_MAX_CONCURRENT', 8),         // simultaneous requests to one host (halves on 429/503, recovers)
  sharedCacheBytes: numZ('SHARED_CACHE_MB', 256) * MB,        // popular library/font files reused across sites (0 = off)
  memAdmitRatio: Number(process.env.MEM_ADMIT_RATIO) > 0 ? Number(process.env.MEM_ADMIT_RATIO) : 0.92, // no extra parallel job above this share of container memory
  diskMinBytes: numZ('DISK_MIN_MB', 700) * MB,                // no extra parallel job when the temp disk has less free space
  metricsToken: process.env.METRICS_TOKEN || '',              // enables GET /metrics (Prometheus text) for requests carrying this token
  logJson: process.env.LOG_FORMAT === 'json',
  telegramApiRoot: process.env.TELEGRAM_API_URL || '',        // self-hosted Telegram Bot API server (lifts the 50 MB limit)
  webhookDomain: (process.env.WEBHOOK_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''), // public host of this service; set it to receive updates by webhook (zero-downtime deploys)
  drainMs: num('DRAIN_SECONDS', 8) * 1000,                    // on shutdown, wait this long for running jobs before exiting
  adminNotify: process.env.ADMIN_NOTIFY !== 'false',        // DM admins on every start and shutdown
  healthPort: Number(process.env.PORT || process.env.HEALTH_PORT || 0) || 0,
  healthEnabled: process.env.HEALTH !== 'false',
  memRecycleRatio: Number(process.env.BROWSER_MEM_RATIO) > 0 ? Number(process.env.BROWSER_MEM_RATIO) : 0.85, // recycle Chromium above this share of the container memory
  browserRecycleAfter: num('BROWSER_RECYCLE_AFTER', 40),
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

// Telegram bots can upload up to 50 MB.
export const TG_MAX_BYTES = (BIG_API ? 1990 : 49) * MB;
// Estimated ZIP size we aim for; anything above this is trimmed (largest media/images first).
export const TG_TARGET_BYTES = 44 * MB;

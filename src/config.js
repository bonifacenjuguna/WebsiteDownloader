const num = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
export const MB = 1024 * 1024;
export const mb = (n) => (n / MB).toFixed(1);

export const CFG = {
  token: process.env.BOT_TOKEN,
  allowedUsers: (process.env.ALLOWED_USERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  enableBrowser: process.env.ENABLE_BROWSER !== 'false',
  maxFileBytes: num('MAX_FILE_MB', 10) * MB,
  maxTotalBytes: num('MAX_TOTAL_MB', 45) * MB,
  maxHtmlBytes: 8 * MB,
  maxFiles: num('MAX_FILES', 1500),
  jobTimeoutMs: num('JOB_TIMEOUT_SEC', 150) * 1000,
  fetchTimeoutMs: 15000,
  assetConcurrency: 16,
  queueConcurrency: num('QUEUE_CONCURRENCY', 2),
  queueMaxWaiting: num('QUEUE_MAX_WAITING', 10),
  cooldownMs: num('COOLDOWN_SEC', 20) * 1000,
  databaseUrl: process.env.DATABASE_URL || '',
  pgSsl: process.env.PGSSL === 'true',
  redisUrl: process.env.REDIS_URL || '',
  adminIds: (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  cacheTtlMs: num('CACHE_TTL_MIN', 360) * 60 * 1000,
  negTtlMs: num('NEG_CACHE_SEC', 300) * 1000,
  retentionDays: num('RETENTION_DAYS', 90),
  browserConcurrency: num('BROWSER_CONCURRENCY', 2),
  browserRecycleAfter: num('BROWSER_RECYCLE_AFTER', 40),
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

// Telegram bots can upload up to 50 MB.
export const TG_MAX_BYTES = 49 * MB;

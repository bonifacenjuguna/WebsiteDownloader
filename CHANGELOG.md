# Changelog

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

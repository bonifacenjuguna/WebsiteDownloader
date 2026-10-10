// Failures that are about the visitor's input or the target site, not about this bot. Used by the admin alerts and by
// /stats, so "real success" does not count a typo or a private address against us.
export const VISITOR_CODES = new Set([
  'invalid_url', 'blocked_address', 'blocked_domain', 'dns', 'not_found', 'not_html', 'cancelled', 'forbidden', 'auth',
  'cloudflare', 'bot_blocked', 'geo_blocked', 'ssl', 'refused', 'reset', 'redirects', 'empty_listing', 'listing_unsavable',
  'queue_full', 'too_many_failures', 'zip_too_big', 'too_large', 'rate_limited', 'http_error', 'server_error',
]);

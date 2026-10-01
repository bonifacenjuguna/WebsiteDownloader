// Analytics / ad / session-replay hosts. Never downloaded, and stripped from the saved pages
// so offline copies don't phone home and open faster.
const HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'facebook.net', 'hotjar.com', 'hotjar.io', 'clarity.ms', 'segment.io', 'segment.com', 'mixpanel.com', 'sentry.io',
  'intercom.io', 'fullstory.com', 'newrelic.com', 'nr-data.net', 'plausible.io', 'amplitude.com', 'heapanalytics.com',
  'hs-analytics.net', 'hs-scripts.com', 'snap.licdn.com', 'analytics.tiktok.com', 'static.ads-twitter.com',
  'ct.pinterest.com', 'quantserve.com', 'scorecardresearch.com', 'taboola.com', 'outbrain.com', 'adroll.com',
  'mouseflow.com', 'crazyegg.com', 'omtrdc.net',
];
const esc = (s) => s.replace(/\./g, '\\.');
const ALT = HOSTS.map(esc).join('|');
const HOST_RE = new RegExp(`(^|\\.)(${ALT})$`, 'i');

export const isTrackerHost = (h) => HOST_RE.test(h);

export function isTrackerUrl(u) {
  try {
    const x = new URL(u);
    return isTrackerHost(x.hostname) || (/(^|\.)facebook\.com$/i.test(x.hostname) && x.pathname.startsWith('/tr'));
  } catch { return false; }
}

// bootstrap snippets of common trackers (only applied to SHORT inline JS scripts)
export const INLINE_TRACKER = /(gtag\(|google-analytics|googletagmanager|_gaq|ga\(\s*['"]create|fbq\(|hotjar|clarity\(|mixpanel|analytics\.js|plausible|dataLayer\s*=|_paq\s*=)/i;
// tracker pixels hiding inside <noscript>
export const TRACKER_MENTION = new RegExp(`(${ALT}|facebook\\.com/tr)`, 'i');

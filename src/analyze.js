import * as cheerio from 'cheerio';

const CF_RE = /just a moment|cf-chl|challenge-platform|checking your browser|attention required! \| cloudflare|enable javascript and cookies to continue/i;
// other bot walls (CAPTCHA pages, Akamai, PerimeterX, DataDome, Imperva...)
// STRICT: phrases that only appear on a wall. Safe to apply to any page (a contact form that mentions "captcha" is not a wall).
const BOT_STRICT = /are you a (human|robot)|unusual traffic from your|verify you are (a )?human|press (&amp; |and )?hold|px-captcha|datadome|pardon our interruption|reference #\d+\.[0-9a-f]+|incapsula incident|request unsuccessful/i;
// LOOSE: broader words, only trusted together with a 403/429/503 status
const BOT_LOOSE = /captcha|access denied|request blocked|perimeterx|incapsula|imperva|akamai|automated (access|requests)/i;
const GEO_RE = /not available in your (country|region|location)|unavailable in your (country|region|location)|isn'?t available in your (country|region)|blocked in your (country|region)|geo-?restrict|due to legal (reasons|demands)|451 unavailable/i;
export const LOGIN_PATH = /\/(log-?in|sign-?in|signin|auth|sso|session\/new|accounts?\/login)(\/|$|\.|\?)/i;

export const isChallengeHtml = (html) => CF_RE.test(html.slice(0, 100000));
export const isBotWallHtml = (html, loose = false) => {
  const head = html.slice(0, 60000);
  return (BOT_STRICT.test(head) || (loose && BOT_LOOSE.test(head))) && visibleTextLength(html) < 1500;
};
export const isGeoHtml = (html) => GEO_RE.test(html.slice(0, 60000));

export function visibleTextLength(html) {
  const $ = cheerio.load(html);
  $('script,style,noscript,template').remove();
  return $('body').text().replace(/\s+/g, ' ').trim().length;
}

export function looksLikeSpa(html) {
  const $ = cheerio.load(html);
  const scripts = $('script[src]').length;
  const noscriptMsg = /enable javascript|requires javascript|need to enable javascript/i.test(html);
  $('script,style,noscript,template').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const emptyRoot = /<div[^>]+id=["'](root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i.test(html);
  return (text.length < 200 && scripts > 0) || (emptyRoot && text.length < 500) || noscriptMsg;
}

// Static HTML that is nearly empty but loads scripts: probably rendered by JavaScript.
export function looksThin(html) {
  const $ = cheerio.load(html);
  const scripts = $('script[src]').length;
  $('script,style,noscript,template').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim().length;
  return text < 600 && scripts >= 1;
}

// Warnings are plain codes ({ c, n? }); the wording lives in copy.js so it can be translated at send time.
// `challenge` means "a real browser might get through"; `code` is what the user sees if it does not.
export function analyze({ status, headers, html, requestedUrl, finalUrl, isHtml }) {
  const warnings = [];
  const host = new URL(finalUrl).host;

  if (headers.get('cf-mitigated') === 'challenge' || ([403, 429, 503].includes(status) && isChallengeHtml(html)))
    return { challenge: true, kind: 'cloudflare', code: 'cloudflare', fatal: `🛡️ ${host} is behind a Cloudflare challenge that blocks automated visitors.`, warnings };

  if (status === 451 || ([401, 403].includes(status) && isGeoHtml(html)))
    return { code: 'geo_blocked', fatal: `🌍 ${host} is not available from this server's region.`, warnings };

  if ([403, 429, 503].includes(status) && isHtml && isBotWallHtml(html, true))
    return { challenge: true, kind: 'bot', code: 'bot_blocked', fatal: `🤖 ${host} blocks automated visitors (bot protection).`, warnings };

  const hasBody = isHtml && html.length > 400;
  if (status === 401 || status === 403) {
    if (hasBody) {
      warnings.push({ c: status === 401 ? 'signIn' : 'restricted' });
    } else {
      return {
        code: headers.get('www-authenticate') ? 'auth' : 'forbidden',
        fatal: headers.get('www-authenticate')
          ? `🔒 ${host} is password protected (HTTP login prompt). I can't get in without credentials.`
          : `🚫 ${host} answered "403 Forbidden" and blocks automated access.`,
        warnings,
      };
    }
  } else if (status === 404 || status === 410) {
    return { code: 'not_found', fatal: `❓ Page not found (HTTP ${status}). Check the address.`, warnings };
  } else if (status === 429) {
    return { code: 'rate_limited', fatal: `⏳ ${host} is rate-limiting me (HTTP 429). Try again later.`, warnings };
  } else if (status >= 500) {
    return { code: 'server_error', fatal: `💥 ${host} has a server error (HTTP ${status}). It may be down.`, warnings };
  } else if (status >= 400) {
    return { code: 'http_error', fatal: `${host} answered with HTTP ${status}.`, warnings };
  }

  const reqPath = new URL(requestedUrl).pathname;
  const finPath = new URL(finalUrl).pathname;
  if (LOGIN_PATH.test(finPath) && !LOGIN_PATH.test(reqPath)) warnings.push({ c: 'signIn' });
  else if (/<input[^>]+type\s*=\s*["']?password/i.test(html)) warnings.push({ c: 'signInForm' });

  return { fatal: null, warnings };
}

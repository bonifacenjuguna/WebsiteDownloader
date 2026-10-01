import * as cheerio from 'cheerio';

const CF_RE = /just a moment|cf-chl|challenge-platform|checking your browser|attention required! \| cloudflare|enable javascript and cookies to continue/i;
const LOGIN_PATH = /\/(log-?in|sign-?in|signin|auth|sso|session\/new|accounts?\/login)(\/|$|\.|\?)/i;

export const isChallengeHtml = (html) => CF_RE.test(html.slice(0, 100000));

export function looksLikeSpa(html) {
  const $ = cheerio.load(html);
  const scripts = $('script[src]').length;
  const noscriptMsg = /enable javascript|requires javascript|need to enable javascript/i.test(html);
  $('script,style,noscript,template').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const emptyRoot = /<div[^>]+id=["'](root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i.test(html);
  return (text.length < 200 && scripts > 0) || (emptyRoot && text.length < 500) || noscriptMsg;
}

export function analyze({ status, headers, html, requestedUrl, finalUrl, isHtml }) {
  const warnings = [];
  const host = new URL(finalUrl).host;

  if (headers.get('cf-mitigated') === 'challenge' || ([403, 429, 503].includes(status) && isChallengeHtml(html)))
    return { challenge: true, fatal: `🛡️ ${host} is behind a Cloudflare challenge that blocks automated visitors, so I can't download it.`, warnings };

  const hasBody = isHtml && html.length > 400;
  if (status === 401 || status === 403) {
    if (hasBody) {
      warnings.push(status === 401
        ? '🔒 The site requires authentication (HTTP 401). I saved the page it served instead.'
        : '🚫 The site answered "403 Forbidden". I saved the page it served instead.');
    } else {
      return {
        fatal: headers.get('www-authenticate')
          ? `🔒 ${host} is password protected (HTTP login prompt). I can't get in without credentials.`
          : `🚫 ${host} answered "403 Forbidden" and blocks automated access.`,
        warnings,
      };
    }
  } else if (status === 404 || status === 410) {
    return { fatal: `❓ Page not found (HTTP ${status}). Check the address.`, warnings };
  } else if (status === 429) {
    return { fatal: `⏳ ${host} is rate-limiting me (HTTP 429). Try again later.`, warnings };
  } else if (status >= 500) {
    return { fatal: `💥 ${host} has a server error (HTTP ${status}). It may be down.`, warnings };
  } else if (status >= 400) {
    return { fatal: `${host} answered with HTTP ${status}.`, warnings };
  }

  const reqPath = new URL(requestedUrl).pathname;
  const finPath = new URL(finalUrl).pathname;
  if (LOGIN_PATH.test(finPath) && !LOGIN_PATH.test(reqPath))
    warnings.push("🔐 The site redirected to a login page. Content behind the login isn't downloadable, so I saved the login page itself.");
  else if (/<input[^>]+type\s*=\s*["']?password/i.test(html))
    warnings.push("🔐 This page has a login form. Anything behind it isn't included.");

  return { fatal: null, warnings };
}

import { CFG } from './config.js';
import { UserError, explainNetError } from './errors.js';
import { safeFetch, readBody } from './net.js';
import { decodeBody } from './extract.js';

// First request for the address the user sent. Tries plain http when a bare domain does not answer on https.
export async function fetchMain(url, explicitScheme, signal) {
  const attempt = async (u) => {
    const { res, url: finalUrl } = await safeFetch(u.href, {
      timeoutMs: 20000,
      signal,
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const body = await readBody(res, CFG.maxHtmlBytes);
    if (body.tooBig) throw new UserError('📏 That page is too large to process.', 'too_large');
    return {
      status: res.status,
      headers: res.headers,
      buf: body.buf,
      finalUrl: finalUrl.href,
      contentType: res.headers.get('content-type') || '',
    };
  };
  try {
    return await attempt(url);
  } catch (e) {
    if (!explicitScheme && url.protocol === 'https:' && !(e instanceof UserError)) {
      const alt = new URL(url.href);
      alt.protocol = 'http:';
      try { return await attempt(alt); } catch { /* report the original error */ }
    }
    throw explainNetError(e, url.host);
  }
}

// One HTML page of a crawl. Keeps the validators (ETag / Last-Modified) so a later "fresh copy" can ask
// "has anything changed?" with conditional requests instead of rebuilding blindly.
export async function fetchHtml(url, { etag, lastModified, signal } = {}) {
  try {
    const headers = { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' };
    if (etag) headers['if-none-match'] = etag;
    if (lastModified) headers['if-modified-since'] = lastModified;
    const { res, url: finalUrl } = await safeFetch(url, { timeoutMs: 20000, headers, signal });
    if (res.status === 304) { res.body?.cancel().catch(() => {}); return { notModified: true, status: 304 }; }
    const type = res.headers.get('content-type') || '';
    if (!res.ok || (type && !/html/i.test(type))) {
      res.body?.cancel().catch(() => {});
      return { fail: res.ok ? 'not an HTML page' : `HTTP ${res.status}`, status: res.status };
    }
    const body = await readBody(res, CFG.maxHtmlBytes);
    if (body.tooBig) return { fail: 'page too large', status: res.status };
    return {
      html: decodeBody(body.buf, type),
      finalUrl: finalUrl.href,
      status: res.status,
      etag: res.headers.get('etag') || null,
      lastModified: res.headers.get('last-modified') || null,
    };
  } catch (e) {
    return { fail: e?.message || 'error', status: 0 };
  }
}

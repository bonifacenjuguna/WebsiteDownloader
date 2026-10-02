import path from 'node:path';
import crypto from 'node:crypto';

const MIME_EXT = {
  'text/html': '.html', 'text/css': '.css', 'text/plain': '.txt',
  'application/javascript': '.js', 'text/javascript': '.js', 'application/x-javascript': '.js',
  'application/json': '.json', 'application/manifest+json': '.webmanifest', 'application/xml': '.xml',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico', 'image/avif': '.avif',
  'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf', 'font/otf': '.otf',
  'application/font-woff2': '.woff2', 'application/font-woff': '.woff',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3',
};

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
export const clean = (s) => s.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/^\.+$/, '_').slice(0, 120);
export const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export function localPathFor(urlStr, mainHost, type = '') {
  const u = new URL(urlStr);
  const segs = u.pathname.split('/').filter(Boolean).map((s) => clean(decode(s)));
  let file = u.pathname.endsWith('/') || segs.length === 0 ? 'index' : segs.pop();
  let ext = path.posix.extname(file);
  const mimeExt = MIME_EXT[type];
  if ((!ext || /^\.\d+$/.test(ext)) && mimeExt) { file += mimeExt; ext = mimeExt; }
  if (u.search) {
    const base = file.slice(0, file.length - ext.length);
    file = `${base}_${sha1(u.search).slice(0, 8)}${ext}`;
  }
  const prefix = u.host === mainHost ? [] : ['_external', clean(u.host.replace(/:/g, '_'))];
  return [...prefix, ...segs, file].join('/');
}

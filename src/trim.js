// Lower rank = dropped first. Rank 3 (HTML, CSS, JS, JSON, SVG) is NEVER left out: dropping code breaks a page,
// while a missing image just falls back to its original online URL.
export const rank = (f) => {
  if (/\.(mp4|webm|mov|mp3|ogg|wav|m4a)$/i.test(f.local) || /^(video|audio)\//.test(f.type)) return 0;
  if (/\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(f.local) || /^image\/(?!svg)/.test(f.type)) return 1;
  if (/\.(pdf|zip|gz|tgz|7z|rar|docx?|xlsx?|pptx?|epub|apk|exe|dmg|iso)$/i.test(f.local)) return 1; // linked documents/archives: already compressed
  if (/\.(woff2?|ttf|otf|eot)$/i.test(f.local) || /^font\//.test(f.type)) return 2;
  return 3;
};
// already-compressed formats stay at full size in the ZIP; text compresses roughly 3x
export const estimate = (f) => (rank(f) <= 2 ? f.size : Math.round(f.size * 0.35));

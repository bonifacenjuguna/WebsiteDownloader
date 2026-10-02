import { CFG } from './config.js';

// What people see BEFORE they press Start (empty chat screen), max 512 chars
export const DESCRIPTION =
  "Turn a website into a portable offline copy. Send a link and get a ZIP with its HTML, CSS, JavaScript, images and fonts, ready to open from index.html. Need a live look first? Get a screenshot preview. JavaScript-heavy sites can be handled with browser mode, while site mode can capture sections and folders. Paste a URL and let the downloader do the work.";
// Shown on the bot's profile page and in shared links, max 120 chars
export const SHORT_DESCRIPTION = "Websites in. Offline ZIPs out. Download pages, assets, sections and more—ready to open locally.";

// Only calls Telegram when the current value differs, so redeploys don't burn rate limits.
async function ensure(tg, label, getMethod, setMethod, key, value) {
  try {
    const cur = await tg.callApi(getMethod, {});
    if ((cur?.[key] ?? '') === value) return `${label}: up to date`;
    await tg.callApi(setMethod, { [key]: value });
    return `${label}: updated`;
  } catch (e) {
    return `${label}: skipped (${e?.message || e})`;
  }
}

export async function syncProfile(tg) {
  if (!CFG.profileSync) return;
  const results = [
    await ensure(tg, 'description', 'getMyDescription', 'setMyDescription', 'description', DESCRIPTION.slice(0, 512)),
    await ensure(tg, 'short description', 'getMyShortDescription', 'setMyShortDescription', 'short_description', SHORT_DESCRIPTION.slice(0, 120)),
    await ensure(tg, 'name', 'getMyName', 'setMyName', 'name', CFG.botName.slice(0, 64)),
  ];
  try {
    await tg.callApi('setChatMenuButton', { menu_button: { type: 'commands' } });
    results.push('menu button: commands');
  } catch (e) {
    results.push(`menu button: skipped (${e?.message || e})`);
  }
  console.log(`Profile sync -> ${results.join(' | ')}`);
}

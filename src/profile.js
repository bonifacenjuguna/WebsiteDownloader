import { CFG } from './config.js';

// What people see BEFORE they press Start (empty chat screen), max 512 chars
export const DESCRIPTION = [
  'Save any website for offline use. Send a link and get a ZIP with its pages, images, styles and scripts. Open index.html and it works without internet.',
  '',
  'Whole sites, not just one page: every page, image and file is saved and linked so it works offline. Big sites arrive as several ZIPs. Also: open folders, dynamic and protected sites, and live previews.',
].join('\n');
// Shown on the bot's profile page and in shared links, max 120 chars
export const SHORT_DESCRIPTION = 'Save entire websites for offline use: every page, image and file.';

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

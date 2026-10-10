import { CFG } from './config.js';

// One line per event. LOG_FORMAT=json prints JSON lines (easy to search in Railway or any log tool);
// the default is a readable "[job] host=example.com ms=31000".
export function event(name, fields = {}, level = 'info') {
  if (CFG.logJson) {
    console.log(JSON.stringify({ t: new Date().toISOString(), level, event: name, ...fields }));
    return;
  }
  const text = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');
  (level === 'warn' ? console.warn : console.log)(`[${name}] ${text}`);
}

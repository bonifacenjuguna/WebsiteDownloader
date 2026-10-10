import fs from 'node:fs';
import { renderEnv, renderTable, TABLE_START, TABLE_END } from './env-vars.js';

// Writes .env and .env.example, and refreshes the configuration table in README.md.
const root = new URL('../', import.meta.url);
const env = renderEnv();
fs.writeFileSync(new URL('.env', root), env);
fs.writeFileSync(new URL('.env.example', root), env);

const readmePath = new URL('README.md', root);
const readme = fs.readFileSync(readmePath, 'utf8');
const block = `${TABLE_START}\n${renderTable()}\n${TABLE_END}`;
const re = new RegExp(`${TABLE_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${TABLE_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
if (!re.test(readme)) { console.error('README.md has no ENV-TABLE markers'); process.exit(1); }
fs.writeFileSync(readmePath, readme.replace(re, () => block));
console.log('Wrote .env, .env.example and the README configuration table.');

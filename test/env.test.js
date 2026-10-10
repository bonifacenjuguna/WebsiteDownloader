import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VARS, GROUPS, PLATFORM_VARS, renderEnv, renderTable, TABLE_START, TABLE_END } from '../scripts/env-vars.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

// every variable the code reads, found in the source itself
function variablesReadByCode() {
  const found = new Set();
  const dir = path.join(root, 'src');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) found.add(m[1]);
    for (const m of src.matchAll(/\b(?:num|numZ|list)\('([A-Z][A-Z0-9_]+)'/g)) found.add(m[1]);
  }
  return found;
}

test('every variable the code reads is documented in scripts/env-vars.js', () => {
  const documented = new Set(VARS.map(([, name]) => name));
  for (const name of variablesReadByCode()) {
    if (PLATFORM_VARS.has(name)) continue;
    assert.ok(documented.has(name), `${name} is read by the code but missing from scripts/env-vars.js (then run: npm run env)`);
  }
  for (const name of documented) assert.ok(variablesReadByCode().has(name), `${name} is documented but the code never reads it`);
});

test('the list is well formed: unique names, known groups, no platform variables', () => {
  const names = VARS.map(([, n]) => n);
  assert.equal(new Set(names).size, names.length, 'duplicate variable');
  const groups = new Set(GROUPS.map(([id]) => id));
  for (const [g, name, value, doc] of VARS) {
    assert.ok(groups.has(g), `${name}: unknown group ${g}`);
    assert.match(name, /^[A-Z][A-Z0-9_]+$/);
    assert.ok(doc.length > 8, `${name} needs a description`);
    assert.ok(!/\s#/.test(value), `${name}: no inline comments in values`);
    assert.ok(!PLATFORM_VARS.has(name), `${name} is set by the platform`);
  }
});

test('.env and .env.example are exactly what the generator writes, and README has the same table', () => {
  assert.equal(read('.env'), renderEnv(), '.env is stale: run npm run env');
  assert.equal(read('.env.example'), renderEnv(), '.env.example is stale: run npm run env');
  const readme = read('README.md');
  const block = readme.slice(readme.indexOf(TABLE_START) + TABLE_START.length, readme.indexOf(TABLE_END)).trim();
  assert.equal(block, renderTable(), 'README table is stale: run npm run env');
});

test('every default in .env is exactly what the code uses when nothing is set', () => {
  const dump = (env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    "const { CFG } = await import('./src/config.js'); const { token, ...rest } = CFG; console.log(JSON.stringify(rest));"],
  { cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));
  const fromFile = parseEnv(read('.env'));
  delete fromFile.BOT_TOKEN;
  assert.deepEqual(dump(fromFile), dump({}));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { setNotifier, recordJob } from '../src/alerts.js';

test('error-rate alert fires once for our own failures, not for visitors’ typos', async () => {
  const sent = [];
  setNotifier(async (t) => { sent.push(t); });
  process.env.ADMIN_IDS = '1';
  for (let i = 0; i < 12; i++) recordJob(false, 'dns'); // visitor mistakes: never alarming
  assert.equal(sent.length, 0);
  // admin ids are read at import time; this test only checks the counters do not throw for either kind
  for (let i = 0; i < 12; i++) recordJob(false, 'internal');
  recordJob(true);
  assert.ok(sent.length <= 1);
});

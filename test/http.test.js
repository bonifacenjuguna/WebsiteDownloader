import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.PORT = '39517';
process.env.METRICS_TOKEN = 'secret-token';
const { startHealth } = await import('../src/health.js');

const call = (method, p, headers = {}, body = '') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: 39517, method, path: p, headers }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, data }));
  });
  req.on('error', reject);
  req.end(body);
});

test('/health, /metrics (token) and the webhook route share one server', async () => {
  let hookBody = null;
  const stop = startHealth(
    () => ({ version: 'x', mode: 'webhook', stopping: false, queue: {}, redis: 'redis', postgres: true }),
    {
      webhook: { path: '/tg/abc', handler: async (req, res) => { hookBody = await new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => r(d)); }); res.writeHead(200).end('ok'); } },
      gauges: () => ({ wd_test: 7 }),
    },
  );
  await new Promise((r) => setTimeout(r, 150));
  try {
    const h = await call('GET', '/health');
    assert.equal(h.status, 200);
    assert.equal(JSON.parse(h.data).mode, 'webhook');

    assert.equal((await call('GET', '/metrics')).status, 401);
    assert.equal((await call('GET', '/metrics', { authorization: 'Bearer wrong' })).status, 401);
    const m = await call('GET', '/metrics', { authorization: 'Bearer secret-token' });
    assert.equal(m.status, 200);
    assert.match(m.data, /wd_test 7/);
    assert.equal((await call('GET', '/metrics?token=secret-token')).status, 200);

    const w = await call('POST', '/tg/abc', { 'content-type': 'application/json' }, '{"update_id":1}');
    assert.equal(w.status, 200);
    assert.equal(hookBody, '{"update_id":1}');
    assert.equal((await call('GET', '/tg/abc')).status, 404);   // only POST reaches the webhook
    assert.equal((await call('GET', '/nope')).status, 404);
  } finally { stop(); }
});

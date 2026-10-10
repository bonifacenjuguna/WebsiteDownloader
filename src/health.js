import http from 'node:http';
import { CFG } from './config.js';
import { browserStats, recycleIfBloated } from './browser.js';
import { memoryShare, memoryMb } from './health-util.js';
import { render as renderMetrics } from './metrics.js';

// One small HTTP server on $PORT:
//   GET  /health   JSON for Railway / uptime monitors (503 while shutting down)
//   GET  /metrics  Prometheus text, only when METRICS_TOKEN is set and sent as "Authorization: Bearer ..." or ?token=
//   POST <hook>    Telegram updates, in webhook mode (zero-downtime deploys)
// plus a watchdog that recycles Chromium when memory runs low.
export function startHealth(getState, { webhook = null, gauges = () => ({}) } = {}) {
  let server = null;
  if (CFG.healthEnabled && CFG.healthPort) {
    server = http.createServer((req, res) => {
      const path = (req.url || '/').split('?')[0];
      if (webhook && req.method === 'POST' && path === webhook.path) {
        Promise.resolve(webhook.handler(req, res)).catch((e) => {
          console.warn('[webhook] handler error:', e?.message);
          if (!res.headersSent) res.writeHead(500).end();
        });
        return;
      }
      if (path === '/metrics') {
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || new URL(req.url, 'http://x').searchParams.get('token');
        if (!CFG.metricsToken || token !== CFG.metricsToken) { res.writeHead(CFG.metricsToken ? 401 : 404).end(); return; }
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(renderMetrics(gauges()));
        return;
      }
      if (path !== '/health' && path !== '/') { res.writeHead(404).end(); return; }
      const st = getState();
      const share = memoryShare();
      const body = JSON.stringify({
        ok: !st.stopping, version: st.version, mode: st.mode, uptimeSec: Math.round(process.uptime()),
        queue: st.queue, redis: st.redis, postgres: st.postgres, browser: browserStats(),
        memory: { rssMb: memoryMb(), containerShare: share == null ? null : Math.round(share * 100) / 100 },
      });
      res.writeHead(st.stopping ? 503 : 200, { 'content-type': 'application/json' }).end(body);
    });
    server.on('error', (e) => console.warn('[health] server error:', e.message));
    server.listen(CFG.healthPort, () => console.log(`HTTP server on :${CFG.healthPort} (/health${CFG.metricsToken ? ', /metrics' : ''}${webhook ? ', webhook' : ''})`));
  }
  const timer = setInterval(() => { recycleIfBloated().catch(() => {}); }, 30_000);
  timer.unref();
  return () => { clearInterval(timer); server?.close(); };
}

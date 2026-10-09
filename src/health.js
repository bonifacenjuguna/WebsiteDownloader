import http from 'node:http';
import { CFG } from './config.js';
import { browserStats, recycleIfBloated } from './browser.js';
import { memoryShare, memoryMb } from './health-util.js';

// GET /health for Railway (or any uptime monitor) + a watchdog that recycles Chromium when memory runs low.
export function startHealth(getState) {
  let server = null;
  if (CFG.healthEnabled && CFG.healthPort) {
    server = http.createServer((req, res) => {
      if (req.url !== '/health' && req.url !== '/') { res.writeHead(404).end(); return; }
      const st = getState();
      const share = memoryShare();
      const body = JSON.stringify({
        ok: !st.stopping, version: st.version, uptimeSec: Math.round(process.uptime()),
        queue: st.queue, redis: st.redis, postgres: st.postgres, browser: browserStats(),
        memory: { rssMb: memoryMb(), containerShare: share == null ? null : Math.round(share * 100) / 100 },
      });
      res.writeHead(st.stopping ? 503 : 200, { 'content-type': 'application/json' }).end(body);
    });
    server.on('error', (e) => console.warn('[health] server error:', e.message));
    server.listen(CFG.healthPort, () => console.log(`Health endpoint on :${CFG.healthPort}/health`));
  }
  const timer = setInterval(() => { recycleIfBloated().catch(() => {}); }, 30_000);
  timer.unref();
  return () => { clearInterval(timer); server?.close(); };
}

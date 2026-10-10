import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CFG } from './config.js';
import { memoryShare } from './health-util.js';

// ---------- disk: how much room is left for jobs ----------
let freeBytes = null;
async function refreshDisk() {
  try { const s = await fs.statfs(os.tmpdir()); freeBytes = Number(s.bavail) * Number(s.bsize); } catch { /* unknown: do not block jobs */ }
}
export const diskFreeMb = () => (freeBytes == null ? null : Math.round(freeBytes / 1048576));

// Admission control for EXTRA parallel jobs: not when the container is nearly out of memory or the temp disk is almost full.
export function canStartMore() {
  const mem = memoryShare();
  if (mem != null && mem >= CFG.memAdmitRatio) return false;
  if (CFG.diskMinBytes && freeBytes != null && freeBytes < CFG.diskMinBytes) return false;
  return true;
}

// ---------- leftovers: a crash or kill can leave job folders behind; remove the old ones ----------
export async function cleanOrphans(maxAgeMs = 40 * 60 * 1000) {
  let removed = 0;
  try {
    for (const name of await fs.readdir(os.tmpdir())) {
      if (!name.startsWith('wd-') || name === 'wd-shared') continue;
      const p = path.join(os.tmpdir(), name);
      const st = await fs.stat(p).catch(() => null);
      if (st?.isDirectory() && Date.now() - st.mtimeMs > maxAgeMs) { await fs.rm(p, { recursive: true, force: true }); removed++; }
    }
  } catch { /* nothing to clean */ }
  return removed;
}

export function startHousekeeping() {
  refreshDisk();
  cleanOrphans().then((n) => { if (n) console.log(`Removed ${n} leftover job folder(s) from a previous run`); });
  const a = setInterval(refreshDisk, 15_000);
  const b = setInterval(() => { cleanOrphans().catch(() => {}); }, 60 * 60 * 1000);
  a.unref(); b.unref();
  return () => { clearInterval(a); clearInterval(b); };
}

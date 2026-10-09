import { readFileSync } from 'node:fs';
import os from 'node:os';

const read = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return null; } };

// Memory used by the whole container (Node + Chromium) as a share of its limit, or null when no limit is known.
export function memoryShare() {
  const pairs = [
    ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.max'],                                   // cgroup v2
    ['/sys/fs/cgroup/memory/memory.usage_in_bytes', '/sys/fs/cgroup/memory/memory.limit_in_bytes'],   // cgroup v1
  ];
  for (const [u, l] of pairs) {
    const used = Number(read(u));
    const lim = read(l);
    if (!used || !lim || lim === 'max') continue;
    const limit = Number(lim);
    if (!Number.isFinite(limit) || limit <= 0 || limit > os.totalmem() * 2) continue; // "unlimited" shows up as a huge number
    return used / limit;
  }
  return null;
}

export const memoryMb = () => Math.round(process.memoryUsage().rss / 1048576);

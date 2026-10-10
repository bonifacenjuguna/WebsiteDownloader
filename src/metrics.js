// Tiny Prometheus-style metrics (counters, a duration histogram, gauges). Exposed at GET /metrics when METRICS_TOKEN is set.
const counters = new Map(); // 'name{a="x"}' -> number
const labelText = (l) => {
  const e = Object.entries(l);
  return e.length ? `{${e.map(([k, v]) => `${k}="${String(v).replace(/[\\"\n]/g, '_')}"`).join(',')}}` : '';
};
export function inc(name, labels = {}, n = 1) {
  const k = `${name}${labelText(labels)}`;
  counters.set(k, (counters.get(k) || 0) + n);
}

const BUCKETS = [1, 5, 10, 30, 60, 120, 300, 600];
const hist = new Map(); // name -> { counts, sum, count }
export function observe(name, seconds) {
  let h = hist.get(name);
  if (!h) { h = { counts: BUCKETS.map(() => 0), sum: 0, count: 0 }; hist.set(name, h); }
  BUCKETS.forEach((b, i) => { if (seconds <= b) h.counts[i]++; });
  h.sum += seconds;
  h.count++;
}

// gauges: { name: number | null }
export function render(gauges = {}) {
  const out = [];
  for (const [k, v] of [...counters].sort()) out.push(`${k} ${v}`);
  for (const [name, h] of hist) {
    BUCKETS.forEach((b, i) => out.push(`${name}_bucket{le="${b}"} ${h.counts[i]}`));
    out.push(`${name}_bucket{le="+Inf"} ${h.count}`, `${name}_sum ${h.sum.toFixed(3)}`, `${name}_count ${h.count}`);
  }
  for (const [k, v] of Object.entries(gauges)) if (v != null && Number.isFinite(Number(v))) out.push(`${k} ${Number(v)}`);
  return `${out.join('\n')}\n`;
}

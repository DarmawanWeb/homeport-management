/**
 * CI guard for the monitoring setup.
 *
 *   tsx scripts/check-monitoring.ts <out-dir>
 *
 * Writes the generated prometheus.yml and rules.yml to <out-dir> (for `promtool check config`).
 * If PROM_URL is set, also sends every PromQL expression used by the Grafana dashboards, the alert
 * rules and the dashboard's built-in charts to that Prometheus and fails on any parse error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultSettings } from '../src/server/config.js';
import { ALERT_RULES, prometheusConfig, rulesConfig } from '../src/server/monitoring/configs.js';
import { allDashboards } from '../src/server/monitoring/dashboards.js';

const out = path.resolve(process.argv[2] ?? '.tmp/monitoring');
fs.mkdirSync(out, { recursive: true });
const settings = { ...defaultSettings(), tunnelMetricsPorts: { ci: 20241 } };
fs.writeFileSync(path.join(out, 'prometheus.yml'), prometheusConfig(settings));
fs.writeFileSync(path.join(out, 'rules.yml'), rulesConfig());
console.log(`wrote ${out}/prometheus.yml and rules.yml`);

const promUrl = process.env.PROM_URL;
if (!promUrl) process.exit(0);

interface Target {
  expr: string;
}
interface Panel {
  title?: string;
  targets?: Target[];
}

const exprs: { where: string; expr: string }[] = [];
for (const { file, json } of allDashboards()) {
  for (const p of json.panels as Panel[])
    for (const t of p.targets ?? []) exprs.push({ where: `${file}: ${p.title}`, expr: t.expr.replaceAll('$app', '.*') });
}
for (const r of ALERT_RULES) exprs.push({ where: `rule ${r.alert}`, expr: r.expr });

let failed = 0;
for (const { where, expr } of exprs) {
  const res = await fetch(`${promUrl}/api/v1/query?query=${encodeURIComponent(expr)}`);
  const body = (await res.json()) as { status: string; error?: string };
  if (body.status !== 'success') {
    failed++;
    console.error(`✖ ${where}\n  ${expr}\n  ${body.error}`);
  }
}
console.log(`${exprs.length} PromQL expressions checked, ${failed} invalid`);
process.exit(failed ? 1 : 0);

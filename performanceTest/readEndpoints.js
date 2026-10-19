

import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

// ---- Load config -----------------------------------------------------
const configPath = __ENV.CONFIG_PATH || './endpoints.json';
const config = JSON.parse(open(configPath));

const BASE_URL = __ENV.BASE_URL || config.baseUrl;

// ---- Build one Trend metric + one threshold per endpoint -------------
// This gives you a separate p95 result and pass/fail per endpoint,
// instead of one blended number across all APIs.
const trends = {};
const thresholds = {};

config.endpoints.forEach((ep) => {
  trends[ep.name] = new Trend(`latency_${ep.name}`, true);
  thresholds[`latency_${ep.name}`] = [
    `p(95)<${ep.p95_target_ms}`,
  ];
});

export const options = {
  vus: config.nominalLoad.vus,
  duration: config.nominalLoad.duration,
  thresholds: thresholds,
};

// ---- Test body: hit every planned endpoint each iteration -------------
export default function () {
  config.endpoints.forEach((ep) => {
    const url = `${BASE_URL}${ep.path}`;
    const res = http.request(ep.method, url);

    trends[ep.name].add(res.timings.duration);

    check(res, {
      [`${ep.name}: status is 2xx`]: (r) => r.status >= 200 && r.status < 300,
      [`${ep.name}: p95 target is ${ep.p95_target_ms}ms`]: () => true, // enforced via thresholds
    });
  });
}

// ---- Readable summary at the end of the run ----------------------------
export function handleSummary(data) {
  const lines = [];
  lines.push('');
  lines.push('=== Read Endpoint p95 Latency Report (nominal load) ===');
  lines.push(`Base URL: ${BASE_URL}`);
  lines.push(`VUs: ${config.nominalLoad.vus}, Duration: ${config.nominalLoad.duration}`);
  lines.push('');

  config.endpoints.forEach((ep) => {
    const metricKey = `latency_${ep.name}`;
    const metric = data.metrics[metricKey];
    const p95 = metric ? metric.values['p(95)'].toFixed(1) : 'N/A';
    const pass = metric && metric.values['p(95)'] < ep.p95_target_ms ? 'PASS' : 'FAIL';
    lines.push(
      `${pass === 'PASS' ? 'PASS' : 'FAIL'} ${ep.name.padEnd(24)} ${ep.method} ${ep.path.padEnd(28)} p95=${p95}ms  target<${ep.p95_target_ms}ms  [${pass}]`
    );
  });

  lines.push('');

  return {
    stdout: lines.join('\n'),
    'summary.json': JSON.stringify(data, null, 2),
  };
}
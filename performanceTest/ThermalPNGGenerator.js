/**
 * k6 test: Thermal PNG generator - interactive UI time requirement
 *
 * Requirement:
 *   REQ-POS-BRIDGE-PNG-01
 *   "Thermal PNG generator shall complete within interactive UI time
 *    for typical ticketing. Target: < 2s for a 10-line KOT/bill."
 *
 * Assumptions (adjust to match your actual API):
 *   - Endpoint: POST {BASE_URL}/api/print/thermal-png
 *   - Request body describes a KOT/bill with a configurable number of
 *     line items (default 10, matching the requirement's "typical" case)
 *   - Response is either raw PNG bytes (Content-Type: image/png) or a
 *     JSON payload with a base64-encoded PNG — both are checked below
 *   - No auth, or a static bearer token via AUTH_TOKEN env var
 *   - This is a single-shot, interactive operation (a user tapping
 *     "print"), not a bulk-throughput operation — so the test is
 *     structured around per-request duration and worst-case latency,
 *     not just p95 under heavy concurrency
 *
 * Usage:
 *   k6 run thermal-png-generator.k6.js
 *   k6 run -e BASE_URL=http://192.168.1.50:8080 -e LINES=10 thermal-png-generator.k6.js
 *   k6 run -e SCENARIO=load -e VUS=5 thermal-png-generator.k6.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

// ---- Config ----------------------------------------------------------

const BASE_URL = __ENV.BASE_URL || '';
const PNG_PATH = __ENV.PNG_PATH || '/api/print/thermal-png';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const LINES = Number(__ENV.LINES || 10); // "typical" KOT/bill line count
const TARGET_MS = 2000;

const pngDuration = new Trend('thermal_png_duration', true);

// ---- Scenarios -------------------------------------------------------
// SCENARIO=smoke -> single user, sequential taps (default; matches the
//                   "interactive" nature of the requirement)
// SCENARIO=load  -> a few concurrent terminals printing at once, to make
//                   sure one busy register doesn't push another over 2s

const SCENARIO = __ENV.SCENARIO || 'smoke';

const scenarios = {
  smoke: {
    executor: 'constant-vus',
    vus: 1,
    duration: '20s',
  },
  load: {
    executor: 'constant-vus',
    vus: Number(__ENV.VUS || 5),
    duration: __ENV.DURATION || '1m',
  },
};

export const options = {
  scenarios: {
    [SCENARIO]: scenarios[SCENARIO],
  },
  thresholds: {
    http_req_duration: [`p(95)<${TARGET_MS}`],
    thermal_png_duration: [`p(95)<${TARGET_MS}`, `max<${TARGET_MS * 1.5}`], // catch worst-case outliers too
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

// ---- Sample payload builder --------------------------------------------

function buildKotPayload(lineCount) {
  const items = [];
  for (let i = 1; i <= lineCount; i++) {
    items.push({
      name: `Item ${i}`,
      qty: 1 + (i % 3),
      notes: i % 4 === 0 ? 'no onions' : '',
    });
  }
  return JSON.stringify({
    ticketType: 'KOT',
    tableNo: 'T-12',
    orderNo: `ORD-${Date.now()}`,
    items,
    printerWidthMm: 80,
  });
}

// ---- Test logic ------------------------------------------------------

export default function () {
  const payload = buildKotPayload(LINES);
  const params = {
    headers: {
      'Content-Type': 'application/json',
      ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    },
    tags: { name: 'generate_thermal_png' },
  };

  const res = http.post(`${BASE_URL}${PNG_PATH}`, payload, params);
  pngDuration.add(res.timings.duration);

  const contentType = res.headers['Content-Type'] || res.headers['content-type'] || '';

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response is a PNG (raw or base64 JSON)': () => {
      if (contentType.includes('image/png')) {
        // Raw PNG bytes: check magic number
        const bytes = res.body;
        return (
          bytes &&
          bytes.length > 8 &&
          bytes.charCodeAt(0) === 0x89 &&
          bytes.charCodeAt(1) === 0x50 // 'P'
        );
      }
      try {
        const body = JSON.parse(res.body);
        const b64 = body.png || body.image || body.data;
        return typeof b64 === 'string' && b64.length > 100;
      } catch (e) {
        return false;
      }
    },
    [`completes under ${TARGET_MS}ms (single-request)`]: (r) => r.timings.duration < TARGET_MS,
  });

  // Interactive usage: a user isn't spamming print repeatedly.
  sleep(1);
}

// ---- Summary -----------------------------------------------------------

export function handleSummary(data) {
//   const p95 = data.metrics.http_req_duration.values['p(95)'];
//   const max = data.metrics.http_req_duration.values['max'];
    const p95 = data.metrics.thermal_png_duration.values['p(95)'];
    const max = data.metrics.thermal_png_duration.values['max'];    
  const passed = p95 < TARGET_MS;

  console.log('');
  console.log('=== Thermal PNG Generator — Requirement Check ===');
  console.log(`Endpoint       : ${BASE_URL}${PNG_PATH}`);
  console.log(`Scenario       : ${SCENARIO}`);
  console.log(`Lines per KOT  : ${LINES}`);
  console.log(`p95 duration   : ${p95.toFixed(2)} ms`);
  console.log(`max duration   : ${max.toFixed(2)} ms`);
  console.log(`Target         : < ${TARGET_MS} ms for a 10-line KOT/bill`);
  console.log(`Result         : ${passed ? 'PASS' : 'FAIL'}`);
  console.log('===================================================');

  return {
    stdout: JSON.stringify(data, null, 2),
  };
}
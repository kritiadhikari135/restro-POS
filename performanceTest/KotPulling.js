import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

/*
  REQUIREMENT UNDER TEST
  ----------------------
  ID: KOT-POLL-001
  Statement: KOT (Kitchen Order Ticket) polling interval ~3 seconds is
             acceptable for Phase 1 reliability.
  Target:    3000ms ± 500ms  ->  acceptable range = [2500ms, 3500ms]
  Pass rule: >= 95% of observed poll intervals must fall within range
             (tune PASS_RATE_THRESHOLD below to match your SLA doc).

  HOW IT WORKS
  ------------
  Each VU repeatedly calls the KOT polling endpoint. We measure the
  wall-clock time between the START of one poll and the START of the
  next poll for the same VU (i.e. the real interval the client
  experiences, including sleep + request time), record it as a Trend,
  and check it against the acceptable range on every iteration.
*/

// ---- Config (override via -e / env vars) ---------------------------------
const BASE_URL   = __ENV.BASE_URL   || '';
const ENDPOINT   = __ENV.ENDPOINT   || '/api/kot/poll';
const TARGET_MS  = Number(__ENV.TARGET_MS  || 3000); // target interval
const TOLERANCE  = Number(__ENV.TOLERANCE_MS || 500); // +/- allowed
const VUS        = Number(__ENV.VUS        || 5);
const DURATION   = __ENV.DURATION   || '2m';
const PASS_RATE_THRESHOLD = Number(__ENV.PASS_RATE_THRESHOLD || 0.95); // 95%

const MIN_MS = TARGET_MS - TOLERANCE; // 2500ms
const MAX_MS = TARGET_MS + TOLERANCE; // 3500ms

// ---- Custom metrics --------------------------------------------------------
const pollInterval   = new Trend('kot_poll_interval_ms', true);
const withinRange    = new Rate('kot_poll_interval_within_range');
const outOfRangeCnt  = new Counter('kot_poll_interval_out_of_range_total');

export const options = {
  scenarios: {
    kot_polling: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      exec: 'pollKOT',
    },
  },
  thresholds: {
    // Reliability requirement: interval must be in range often enough
    'kot_poll_interval_within_range': [`rate>=${PASS_RATE_THRESHOLD}`],
    // Central tendency sanity check: median should sit near target
    'kot_poll_interval_ms': [
      `p(50)>=${MIN_MS}`,
      `p(50)<=${MAX_MS}`,
    ],
    // Basic API health alongside polling-interval reliability
    http_req_failed: ['rate<0.01'],
  },
};

// Per-VU state: timestamp of the previous poll start
let lastPollStart = null;

export function pollKOT() {
  const now = Date.now();

  if (lastPollStart !== null) {
    const interval = now - lastPollStart;
    pollInterval.add(interval);

    const inRange = interval >= MIN_MS && interval <= MAX_MS;
    withinRange.add(inRange);
    if (!inRange) {
      outOfRangeCnt.add(1);
    }

    check(interval, {
      [`interval within ${TARGET_MS}ms +/- ${TOLERANCE}ms`]: () => inRange,
    });
  }

  lastPollStart = now;

  const res = http.get(`${BASE_URL}${ENDPOINT}`, {
    tags: { name: 'KOT_Poll' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  // Sleep to target the ~3s cadence; the *actual* achieved interval
  // (sleep + request latency) is what we measure above on the next loop.
  const elapsed = Date.now() - now;
  const sleepFor = Math.max(0, TARGET_MS - elapsed) / 1000;
  sleep(sleepFor);
}

export function handleSummary(data) {
  const rate = data.metrics.kot_poll_interval_within_range
    ? data.metrics.kot_poll_interval_within_range.values.rate
    : null;
  const p50 = data.metrics.kot_poll_interval_ms
    ? data.metrics.kot_poll_interval_ms.values['p(50)']
    : null;
  const avg = data.metrics.kot_poll_interval_ms
    ? data.metrics.kot_poll_interval_ms.values.avg
    : null;

  const verdict = rate !== null && rate >= PASS_RATE_THRESHOLD ? 'PASS' : 'FAIL';

  const summaryText =
    `\n=== KOT-POLL-001: Polling Interval Reliability ===\n` +
    `Target interval : ${TARGET_MS}ms +/- ${TOLERANCE}ms  (range ${MIN_MS}-${MAX_MS}ms)\n` +
    `Observed avg    : ${avg !== null ? avg.toFixed(1) : 'n/a'}ms\n` +
    `Observed p50    : ${p50 !== null ? p50.toFixed(1) : 'n/a'}ms\n` +
    `In-range rate   : ${rate !== null ? (rate * 100).toFixed(2) : 'n/a'}%  (threshold >= ${(PASS_RATE_THRESHOLD * 100).toFixed(0)}%)\n` +
    `Result          : ${verdict}\n` +
    `====================================================\n`;

  return {
    stdout: summaryText,
    'summary.json': JSON.stringify(data, null, 2),
  };
}
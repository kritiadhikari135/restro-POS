/**
 * k6 test: POS Bridge - list endpoint latency requirement
 *
 * Requirement:
 *   REQ-POS-BRIDGE-LIST-01
 *   "List endpoints shall respond quickly for <=200 in-memory orders.
 *    Target: p95 < 150ms on LAN."
 *
 * Assumptions (adjust to match your actual API):
 *   - Endpoint: GET {BASE_URL}/api/orders
 *   - In-memory dataset seeded with <= 200 orders before the test runs
 *   - No auth, or a static bearer token via AUTH_TOKEN env var
 *   - Test is executed from a machine on the same LAN as the bridge
 *     (network RTT should be sub-millisecond; if it's not, that's not
 *     the bridge's fault and the threshold should be re-evaluated)
 *
 * Usage:
 *   k6 run pos-bridge-list-endpoint.k6.js
 *   k6 run -e BASE_URL=http://192.168.1.50:8080 -e SCENARIO=load pos-bridge-list-endpoint.k6.js
 *   k6 run -e AUTH_TOKEN=xyz pos-bridge-list-endpoint.k6.js
 */
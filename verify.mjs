import assert from 'node:assert/strict';

try {
  const port = process.env.PORT || '8080';
  const base = process.env.BASE_URL || `http://127.0.0.1:${port}`;
  const request = async (route, headers = {}) => fetch(new URL(route, base), { headers, signal: AbortSignal.timeout(10000) });
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, 'mdshare-deployment-probe');
  assert.equal((await request('/api/report')).status, 401);
  if (!process.env.ACCESS_TOKEN) throw new Error('ACCESS_TOKEN is required for verification');
  const response = await request('/api/report', { Authorization: `Bearer ${process.env.ACCESS_TOKEN}` });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.ok(report.persistence.id);
  if (process.env.EXPECTED_MARKER_ID) assert.equal(report.persistence.id, process.env.EXPECTED_MARKER_ID);
  if (process.env.MIN_BOOTS) assert.ok(report.persistence.boots >= Number(process.env.MIN_BOOTS));
  console.log(JSON.stringify({ ok: true, persistence: report.persistence, runtime: report.runtime, scope: report.scope }, null, 2));
} catch (error) {
  console.error(`Verification failed: ${error.message}`);
  process.exitCode = 1;
}
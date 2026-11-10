import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';

const origin = 'https://recovery.example';
test('deployed Worker serves embedded public assets with appropriate MIME types', async () => {
  for (const [pathname, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/overview.js', 'text/javascript'], ['/styles.css', 'text/css'], ['/engine.js', 'text/javascript'], ['/sources.js', 'text/javascript'], ['/favicon.svg', 'image/svg+xml']]) {
    const response = await worker.fetch(new Request(origin + pathname), {});
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('Content-Type').startsWith(type));
    assert.ok((await response.text()).length > 0);
  }
  const head = await worker.fetch(new Request(origin + '/', { method: 'HEAD' }), {});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('deployed Worker does not expose server source, environment files or build metadata', async () => {
  for (const pathname of ['/server/index.js', '/src/ai.js', '/.env', '/.openai/hosting.json', '/package.json']) {
    assert.equal((await worker.fetch(new Request(origin + pathname), {})).status, 404);
  }
});

test('deployed Worker health exposes configuration status without the secret', async () => {
  const response = await worker.fetch(new Request(origin + '/api/health'), { DEEPSEEK_API_KEY: 'test-runtime-only-secret', DEEPSEEK_MODEL: 'deepseek-flash' });
  assert.deepEqual(await response.json(), { provider: 'DeepSeek', configured: true, model: 'deepseek-flash' });
});

test('deployed Worker retains rule fallback and applies same-origin API validation', async () => {
  const body = JSON.stringify({ amount: 12000, dueDate: '2026-09-01', issueText: '虚构测试：尚未完成对账。' });
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body };
  const response = await worker.fetch(new Request(origin + '/api/plan', options), {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.plan.amount, 12000);
  assert.equal(payload.plan.generation.mode, 'rules');
  assert.equal(payload.plan.ai, undefined);
  assert.equal(payload.plan.legalReview.schemaVersion, '1.0');
  const payment = payload.plan.legalReview.findings.find(({ id }) => id === 'payment-claim');
  assert.equal(payment.status, 'insufficient');
  const statute = payment.citations.find(({ id }) => id === 'civil-579');
  assert.match(statute.text, /未支付价款/);
  assert.ok(statute.officialUrl && statute.versionId && statute.verifiedAt);
  const crossOrigin = await worker.fetch(new Request(origin + '/api/plan', { ...options, headers: { ...options.headers, Origin: 'https://another.example' } }), {});
  assert.equal(crossOrigin.status, 403);
});

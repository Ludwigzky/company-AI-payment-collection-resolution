import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAPI } from '../src/api.js';

const ORIGIN = 'https://private.example.test';
const ENV = { DEEPSEEK_API_KEY: 'api-server-secret' };
const INPUT = { amount: 12000, dueDate: '2026-10-10', issueText: '双方正在核对已交付项目款项。', projectType: 'general', acceptanceStatus: 'passed' };
const ADVICE = {
  analysis: '待付金额及付款条件仍需双方核对。', strategy: '先对账，再协商书面安排。',
  recommendations: [{ track: 'business', advice: '形成逐项对账清单。', steps: ['核对合同和流水。'], sourceIds: ['civil-code'] }],
  followUpQuestions: [], communicationDraft: '请协助核对项目款项及付款条件。',
};
const options = { today: '2026-11-10' };
const request = (body = INPUT, extra = {}) => new Request(`${ORIGIN}/api/plan`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...extra.headers },
  body: typeof body === 'string' ? body : JSON.stringify(body), ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'headers')),
});

test('health exposes only provider configuration and never calls the provider', async () => {
  let calls = 0;
  const response = await handleAPI(new Request(`${ORIGIN}/api/health`), ENV, { fetchImpl: () => { calls += 1; } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { provider: 'DeepSeek', configured: true, model: 'deepseek-flash' });
  assert.equal(calls, 0);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  const disabled = await handleAPI(new Request(`${ORIGIN}/api/health`));
  assert.equal((await disabled.json()).configured, false);
});

test('POST returns a safe rules fallback when a secret is absent', async () => {
  const response = await handleAPI(request(), {}, options);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  const { plan } = await response.json();
  assert.equal(plan.generation.mode, 'rules');
  assert.equal(plan.amount, INPUT.amount);
  assert.equal(plan.overdueDays, 31);
  assert.equal(plan.generatedAt, options.today);
  assert.equal(plan.ai, undefined);
});

test('POST forwards only case input and returns a validated AI supplement', async () => {
  let calls = 0;
  const response = await handleAPI(request({ ...INPUT, model: 'hacked', endpoint: 'https://evil.invalid', key: 'client-secret' }), ENV, {
    ...options,
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(JSON.parse(init.body).model, 'deepseek-flash');
      assert.doesNotMatch(init.body, /hacked|evil\.invalid|client-secret/);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(ADVICE), reasoning_content: 'hidden' } }] }));
    },
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  const body = await response.json();
  assert.equal(body.plan.generation.mode, 'ai');
  assert.deepEqual(body.plan.ai, ADVICE);
  assert.equal(body.plan.amount, INPUT.amount);
  assert.doesNotMatch(JSON.stringify(body), /api-server-secret|Authorization|reasoning_content|hidden/);
});

test('cross-origin requests and cross-site browser submissions are rejected before spending', async () => {
  let calls = 0;
  for (const headers of [
    { Origin: 'https://evil.invalid' }, { Origin: 'null' }, { Origin: `${ORIGIN}/` },
    { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const response = await handleAPI(request(INPUT, { headers }), ENV, { fetchImpl: () => { calls += 1; } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  const health = await handleAPI(new Request(`${ORIGIN}/api/health`, { headers: { Origin: 'https://evil.invalid' } }), ENV);
  assert.equal(health.status, 403);
  assert.equal(calls, 0);
});

test('same-origin JSON clients without an Origin header can use the API', async () => {
  const response = await handleAPI(new Request(`${ORIGIN}/api/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(INPUT) }), {}, options);
  assert.equal(response.status, 200);
});

test('unknown routes and wrong methods have explicit status and no provider calls', async () => {
  let calls = 0;
  const noFetch = { fetchImpl: () => { calls += 1; } };
  for (const [path, method, status, allow] of [
    ['/api/other', 'GET', 404, null], ['/api/plan', 'GET', 405, 'POST'],
    ['/api/plan', 'OPTIONS', 405, 'POST'], ['/api/health', 'POST', 405, 'GET'],
  ]) {
    const response = await handleAPI(new Request(`${ORIGIN}${path}`, { method }), ENV, noFetch);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Allow'), allow);
  }
  assert.equal(calls, 0);
});

test('invalid JSON, non-JSON media and invalid fields return 400 without a provider request', async () => {
  let calls = 0;
  const invalid = [
    request('{broken'), request(''), request('null'), request('[]'), request({ ...INPUT, amount: -5 }),
    request({ ...INPUT, dueDate: '2026-02-30' }), request({ ...INPUT, issueText: '' }),
    request(INPUT, { headers: { 'Content-Type': 'text/plain' } }),
    request(INPUT, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }),
  ];
  for (const item of invalid) {
    const response = await handleAPI(item, ENV, { ...options, fetchImpl: () => { calls += 1; } });
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal(calls, 0);
});

test('body limit counts streamed UTF-8 bytes and does not trust Content-Length', async () => {
  let calls = 0;
  const noFetch = { ...options, fetchImpl: () => { calls += 1; } };
  const declared = request(INPUT, { headers: { 'Content-Length': String(32 * 1024 + 1) } });
  assert.equal((await handleAPI(declared, ENV, noFetch)).status, 413);
  const utf8 = new TextEncoder().encode(JSON.stringify({ ...INPUT, issueText: '测'.repeat(12000) }));
  const streamed = new Request(`${ORIGIN}/api/plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '1' }, duplex: 'half',
    body: new ReadableStream({ start(controller) { controller.enqueue(utf8.slice(0, 10000)); controller.enqueue(utf8.slice(10000)); controller.close(); } }),
  });
  assert.equal((await handleAPI(streamed, ENV, noFetch)).status, 413);
  assert.equal(calls, 0);
});

test('provider failures stay HTTP 200 with a reviewable rules plan and safe reason', async () => {
  const response = await handleAPI(request(), ENV, { ...options, fetchImpl: async () => new Response('api-server-secret Authorization internal billing', { status: 402 }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.plan.generation.mode, 'rules');
  assert.equal(result.plan.ai, undefined);
  assert.match(result.plan.generation.reason, /暂不可用/);
  assert.doesNotMatch(JSON.stringify(result), /api-server-secret|Authorization|internal billing/);
});

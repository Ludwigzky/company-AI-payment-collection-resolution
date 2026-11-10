import test from 'node:test';
import assert from 'node:assert/strict';
import { probeDeepSeek } from '../src/provider-probe.js';

const KEY = 'sk-dummy-probe-key';
const MODEL = 'deepseek-flash';
function run(fetchImpl, extra = {}) { return probeDeepSeek({ key: KEY, model: MODEL, fetchImpl, ...extra }); }
function payload(data) { return new Response(JSON.stringify({ data })); }

test('the probe classifies provider errors and never returns an upstream body, header or URL', async () => {
  for (const [code, expected] of [[401, 'auth_error'], [402, 'insufficient_balance'], [429, 'rate_limited'], [500, 'unavailable'], [503, 'unavailable'], [502, 'unavailable'], [400, 'invalid_response'], [302, 'invalid_response']]) {
    const result = await run(async (url, init) => {
      assert.equal(url, 'https://api.deepseek.com/models'); assert.equal(init.redirect, 'manual'); assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
      return new Response(`unsafe provider echo ${KEY}`, { status: code, headers: { Location: 'https://unsafe.example/credentials' } });
    });
    assert.equal(result.status, expected);
    assert.doesNotMatch(JSON.stringify(result), /sk-dummy|unsafe|Bearer|https:/);
  }
  assert.equal((await run(async () => { throw new Error(`unsafe ${KEY}`); })).status, 'network_error');
});

test('online requires the exact model, and image capability is only reported from known metadata', async () => {
  const online = await run(async () => payload([{ id: MODEL }]));
  assert.equal(online.status, 'online'); assert.equal(online.modelAvailable, true); assert.equal('supportsImages' in online, false);
  assert.match(online.detail, /不能确认余额/);
  const text = await run(async () => payload([{ id: MODEL, input_modalities: ['text'] }])); assert.equal(text.supportsImages, false);
  const image = await run(async () => payload([{ id: MODEL, input_modalities: ['text', 'image'] }])); assert.equal(image.supportsImages, true);
  const invalidMetadata = await run(async () => payload([{ id: MODEL, input_modalities: 'image' }])); assert.equal('supportsImages' in invalidMetadata, false);
  const missing = await run(async () => payload([{ id: 'deepseek-other' }])); assert.equal(missing.status, 'model_unavailable'); assert.equal(missing.modelAvailable, false);
  assert.equal((await run(async () => payload([]))).status, 'model_unavailable');
  assert.equal((await run(async () => new Response('{'))).status, 'invalid_response');
  assert.equal((await run(async () => new Response(JSON.stringify({ data: [{ wrong: MODEL }] })))).status, 'invalid_response');
});

test('the 64KiB response limit handles declared and streamed bodies', async () => {
  const declared = await run(async () => new Response('{}', { headers: { 'Content-Length': String(64 * 1024 + 1) } })); assert.equal(declared.status, 'invalid_response');
  const streamed = await run(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(64 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); } })));
  assert.equal(streamed.status, 'invalid_response');
  const invalidUtf8 = await run(async () => new Response(Uint8Array.of(255, 255))); assert.equal(invalidUtf8.status, 'invalid_response');
});

test('the deadline covers a hanging fetch and a hanging body, with an abort signal and no retry', async () => {
  let calls = 0; let signal;
  const hangingFetch = await run(async (_url, init) => { calls += 1; signal = init.signal; return new Promise(() => {}); }, { timeoutMs: 15 });
  assert.equal(hangingFetch.status, 'timeout'); assert.equal(calls, 1); assert.equal(signal.aborted, true);
  let cancelled = false;
  const hangingBody = await run(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":')); }, cancel() { cancelled = true; } })), { timeoutMs: 15 });
  assert.equal(hangingBody.status, 'timeout'); assert.equal(cancelled, true);
});

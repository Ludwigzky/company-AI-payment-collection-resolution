import test from 'node:test';
import assert from 'node:assert/strict';
import { isContextAuditRequest, passedAuditResponse } from './helpers/context-audit.mjs';
import { createLocalStorage } from '../src/local-storage.mjs';
import { handleAPI } from '../src/api.js';

const ORIGIN = 'https://provider-integration.example';
const MASTER = Buffer.alloc(32, 7).toString('base64');
const DEFAULT_KEY = 'environment-test-key-only';
const SAVED_KEY = 'manually-saved-test-key-only';
const input = { amount: 12000, dueDate: '2026-10-01', issueText: '虚构测试：等待对账及协商付款。', projectType: 'general', disputeClause: 'unknown' };
function request(path, { method = 'GET', owner = 'alice', body, origin = ORIGIN } = {}) {
  return new Request(ORIGIN + '/api' + path, { method, headers: { Origin: origin, ...(owner ? { 'oai-authenticated-user-id': owner } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function setup(t) { const store = await createLocalStorage({ memory: true }); t.after(() => store.close()); return { ...store, AI_CONFIG_ENCRYPTION_KEY: MASTER, DEEPSEEK_API_KEY: DEFAULT_KEY }; }
async function call(env, path, options, extra = {}) { return handleAPI(request(path, options), env, { today: '2026-11-10', ...extra }); }
function upstream() { return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ analysis: '用户填报款项及履约情况尚需核对。', strategy: '整理对账材料并协商书面安排。', recommendations: [{ track: 'business', advice: '整理款项及资料清单。', steps: ['核对合同及流水，记录需双方确认的事项。'], sourceIds: ['civil-code'] }], followUpQuestions: [], communicationDraft: '请协助核对本项目资料及款项，并反馈书面安排。' }) } }] })); }
async function createCase(env, owner = 'alice') { const res = await call(env, '/records', { owner, method: 'POST', body: { title: '虚构配置联调案件', input } }); assert.equal(res.status, 201); return (await res.json()).record; }

test('saved account credentials and model are used by the real case analysis route without changing shared defaults', async (t) => {
  const env = await setup(t);
  const record = await createCase(env);
  const save = await call(env, '/provider', { method: 'PATCH', body: { revision: 0, action: 'save', apiKey: SAVED_KEY, model: 'deepseek-v4-pro' } });
  assert.equal(save.status, 200);
  const metadata = await save.json();
  assert.equal(metadata.source, 'saved');
  assert.equal(metadata.lastCheck, null, 'saving must not claim connectivity');
  assert.doesNotMatch(JSON.stringify(metadata), /manually-saved-test-key-only|environment-test-key-only|ciphertext|fingerprint/);
  const health = await (await call(env, '/health')).json();
  assert.equal(health.model, 'deepseek-v4-pro');
  assert.equal(health.configured, true);
  let calls = 0;
  const analysis = await call(env, '/records/' + record.id + '/analyze', { method: 'POST', body: { revision: record.revision, attachmentIds: [] } }, { fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.ok(init.headers.Authorization === 'Bearer ' + SAVED_KEY, 'only this account credential is forwarded');
    assert.equal(JSON.parse(init.body).model, 'deepseek-v4-pro');
    if (isContextAuditRequest(init)) return passedAuditResponse(init);
    return upstream();
  } });
  assert.equal(analysis.status, 200);
  assert.equal((await analysis.json()).plan.generation.mode, 'ai');
  assert.equal(calls, 2);
  assert.ok(env.DEEPSEEK_API_KEY === DEFAULT_KEY, 'the shared default environment remains unchanged');
  const other = await (await call(env, '/provider', { owner: 'bob' })).json();
  assert.equal(other.source, 'environment');
  assert.equal(other.model, 'deepseek-flash');
});

test('disable keeps rules and legal review usable; restoring defaults affects subsequent requests', async (t) => {
  const env = await setup(t);
  const record = await createCase(env);
  const disabled = await call(env, '/provider', { method: 'PATCH', body: { revision: 0, action: 'disable' } });
  assert.equal(disabled.status, 200);
  const state = await disabled.json();
  let calls = 0;
  const analysis = await call(env, '/records/' + record.id + '/analyze', { method: 'POST', body: { revision: record.revision, attachmentIds: [] } }, { fetchImpl: () => { calls++; throw new Error('disabled service must not make provider requests'); } });
  const payload = await analysis.json();
  assert.equal(analysis.status, 200);
  assert.equal(calls, 0);
  assert.equal(payload.plan.generation.mode, 'rules');
  assert.ok(payload.plan.legalReview.findings.length > 0);
  const restored = await call(env, '/provider', { method: 'PATCH', body: { revision: state.revision, action: 'default' } });
  assert.equal(restored.status, 200);
  const fresh = await restored.json();
  assert.equal(fresh.source, 'environment');
  assert.equal(fresh.configured, true);
  assert.equal(fresh.lastCheck, null);
});

test('unreadable saved credentials fail closed and provider routes enforce same-origin identity', async (t) => {
  const env = await setup(t);
  const record = await createCase(env);
  assert.equal((await call(env, '/provider', { owner: '' })).status, 401);
  assert.equal((await call(env, '/provider', { origin: 'https://foreign.example' })).status, 403);
  await call(env, '/provider', { method: 'PATCH', body: { revision: 0, action: 'save', apiKey: SAVED_KEY } });
  const changedMaster = { ...env, AI_CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64') };
  const state = await (await call(changedMaster, '/provider')).json();
  assert.equal(state.configured, false);
  assert.equal(state.configurationError, 'saved_key_unreadable');
  let calls = 0;
  const denied = await call(changedMaster, '/records/' + record.id + '/analyze', { method: 'POST', body: { revision: record.revision, attachmentIds: [] } }, { fetchImpl: () => { calls++; throw new Error('do not fall through to environment key'); } });
  assert.equal(denied.status, 503);
  assert.equal(calls, 0);
  assert.doesNotMatch(await denied.text(), /manually-saved-test-key-only|environment-test-key-only|ciphertext|fingerprint/);
  assert.equal((await call(changedMaster, '/plan', { method: 'POST', body: input })).status, 409);
});

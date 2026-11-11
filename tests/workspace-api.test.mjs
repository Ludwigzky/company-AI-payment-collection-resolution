import test from 'node:test';
import assert from 'node:assert/strict';
import { isContextAuditRequest, passedAuditResponse, passedAuditPayload, auditResponse } from './helpers/context-audit.mjs';
import { handleAPI } from '../src/api.js';
import { createLocalStorage } from '../src/local-storage.mjs';

const origin = 'https://workspace.example';
const baseInput = { amount: 35000, dueDate: '2026-08-01', issueText: '虚构测试：项目交付后等待付款，资料尚待核对。', projectType: 'equipment', evidence: ['contract', 'delivery'], disputeClause: 'unknown' };
function request(path, { owner = 'alice', method = 'GET', body, headers = {} } = {}) {
  return new Request(origin + '/api' + path, { method, headers: { Origin: origin, ...(owner ? { 'oai-authenticated-user-id': owner } : {}), ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
}
async function setup(t) { const storage = await createLocalStorage({ memory: true }); t.after(() => storage.close()); return { ...storage }; }
async function call(env, path, options, aiOptions) { return handleAPI(request(path, options), env, aiOptions); }
async function create(env, title, owner = 'alice') {
  const response = await call(env, '/records', { method: 'POST', owner, body: { title, input: baseInput } });
  assert.equal(response.status, 201);
  return (await response.json()).record;
}
async function upload(env, id, text, owner = 'alice', name = '同名项目材料.txt') {
  const form = new FormData(); form.set('file', new File([text], name, { type: 'text/plain' }));
  return call(env, `/records/${id}/attachments`, { owner, method: 'POST', body: form });
}
function providerResponse(init) {
  const content = init ? JSON.parse(init.body).messages[1].content : null;
  const context = Array.isArray(content) ? JSON.parse(content[0].text.slice(content[0].text.indexOf('{'))) : {};
  const materialFindings = (context.materialDirectory || []).map((item) => ({ attachmentId: item.id, finding: item.marker + '本次可见文字提供项目事项线索，需核对原件及付款条件。', location: 'TXT提取内容', uncertainty: '提取内容不能证明真实，需核对原件。' }));
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ analysis: '根据本次案件已提交的材料，建议核对合同履约及金额，保留待确认事项。', strategy: '先整理对账与项目清单，再协商书面安排。', recommendations: [{ track: 'business', advice: '逐项确认款项与材料。', steps: ['核查交付资料并向对方申请书面确认。'], sourceIds: ['civil-code'] }], followUpQuestions: ['是否有双方确认的对账记录？'], communicationDraft: '请协助核对本项目资料和款项，书面反馈可以确认的支付安排。', ...(materialFindings.length ? { materialFindings } : {}) }) } }] }));
}

test('case endpoints require a trusted identity and isolate cases between users', async (t) => {
  const env = await setup(t);
  assert.equal((await call(env, '/records', { owner: '' })).status, 401);
  const alice = await create(env, '甲方项目');
  const bob = await create(env, '乙方项目', 'bob');
  const list = await (await call(env, '/records')).json();
  assert.deepEqual(list.records.map((item) => item.id), [alice.id]);
  assert.equal((await call(env, '/records/' + bob.id)).status, 404);
  assert.equal((await call(env, '/records/' + alice.id, { owner: 'bob', method: 'PATCH', body: { revision: 1, title: '越权' } })).status, 404);
  assert.equal((await call(env, '/records', { method: 'POST', body: { title: '伪造用户', owner: 'bob' } })).status, 400);
});

test('same-named uploaded files remain bound to their parent case and private owner', async (t) => {
  const env = await setup(t);
  const a = await create(env, '项目A'); const b = await create(env, '项目B');
  const uploadedA = await (await upload(env, a.id, '仅属于项目A：维修节点待确认。')).json();
  const uploadedB = await (await upload(env, b.id, '仅属于项目B：支付计划待确认。')).json();
  const aid = uploadedA.attachment.id; const bid = uploadedB.attachment.id;
  assert.notEqual(aid, bid);
  assert.equal(JSON.stringify(uploadedA).includes('objectKey'), false);
  const own = await call(env, `/records/${a.id}/attachments/${aid}/content`);
  assert.equal(own.status, 200); assert.match(await own.text(), /仅属于项目A/);
  assert.equal((await call(env, `/records/${a.id}/attachments/${bid}/content`)).status, 404);
  assert.equal((await call(env, `/records/${a.id}/attachments/${aid}/content`, { owner: 'bob' })).status, 404);
  assert.equal((await call(env, `/records/${a.id}/attachments/${bid}`, { method: 'DELETE' })).status, 404);
});

test('an uncertain database acknowledgement cannot delete an already archived file', async (t) => {
  const env = await setup(t); const record = await create(env, '存储应答测试');
  const batch = env.DB.batch.bind(env.DB);
  let injected = false;
  env.DB.batch = (statements) => {
    const result = batch(statements);
    if (!injected && statements.some((statement) => /INSERT INTO recovery_attachments/.test(statement.sql))) {
      injected = true; throw new Error('simulated acknowledgement loss after commit');
    }
    return result;
  };
  assert.equal((await upload(env, record.id, '已归档文件应在应答不确定时保留。')).status, 500);
  const saved = (await (await call(env, '/records/' + record.id)).json()).record;
  assert.equal(saved.attachments.length, 1);
  assert.equal(env.BUCKET.objects.size, 1);
  const content = await call(env, `/records/${record.id}/attachments/${saved.attachments[0].id}/content`);
  assert.equal(content.status, 200); assert.match(await content.text(), /已归档文件/);
});

test('analysis resolves only current-case file IDs and never forwards another case', async (t) => {
  const env = { ...await setup(t), DEEPSEEK_API_KEY: 'mock-provider-key' };
  const a = await create(env, '项目A'); const b = await create(env, '项目B');
  const ua = await (await upload(env, a.id, '项目A材料专有标记 ALPHA-ONLY。')).json();
  const ub = await (await upload(env, b.id, '项目B材料专有标记 BETA-ONLY。')).json();
  let calls = 0;
  const ai = { today: '2026-11-10', fetchImpl: async (_url, init) => {
    calls += 1;
    const content = JSON.stringify(JSON.parse(init.body).messages);
    assert.match(content, /ALPHA-ONLY/); assert.doesNotMatch(content, /BETA-ONLY/);
    if (isContextAuditRequest(init)) return passedAuditResponse(init);
    return providerResponse(init);
  } };
  const rejected = await call(env, `/records/${a.id}/analyze`, { method: 'POST', body: { revision: ua.record.revision, attachmentIds: [ub.attachment.id] } }, ai);
  assert.equal(rejected.status, 404); assert.equal(calls, 0);
  const response = await call(env, `/records/${a.id}/analyze`, { method: 'POST', body: { revision: ua.record.revision, attachmentIds: [ua.attachment.id] } }, ai);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(calls, 2); assert.equal(payload.plan.generation.mode, 'ai');
  assert.equal(payload.plan.contextAudit.status, 'passed');
  assert.equal(payload.run.recordId, a.id);
  assert.deepEqual(payload.run.attachmentIds, [ua.attachment.id]);
  assert.equal(payload.record.runs.length, 1);
  assert.ok(payload.run.plan.legalReview.findings.length > 0);
  assert.deepEqual(payload.run.plan.legalReview, payload.plan.legalReview);
  const reloaded = (await (await call(env, '/records/' + a.id)).json()).record;
  assert.deepEqual(reloaded.runs[0].plan.legalReview, payload.plan.legalReview, 'law text and version survive a stored snapshot reload');
  assert.deepEqual(reloaded.runs[0].plan.contextAudit, payload.plan.contextAudit, 'context audit survives a stored snapshot reload');
  assert.doesNotMatch(JSON.stringify(reloaded.runs[0].plan.legalReview), /BETA-ONLY/);
  assert.equal((await (await call(env, '/records/' + b.id)).json()).record.runs.length, 0);
});

test('an in-flight result archives its original snapshot without overwriting later edits', async (t) => {
  const env = { ...await setup(t), DEEPSEEK_API_KEY: 'mock-provider-key' };
  const record = await create(env, '生成中的项目');
  let release; let started;
  const atProvider = new Promise((resolve) => { started = resolve; });
  const responseGate = new Promise((resolve) => { release = resolve; });
  const work = call(env, `/records/${record.id}/analyze`, { method: 'POST', body: { revision: record.revision, attachmentIds: [] } }, { fetchImpl: async (_url, init) => { if (isContextAuditRequest(init)) { assert.match(init.body, /35000/); assert.doesNotMatch(init.body, /99000/); return passedAuditResponse(init); } started(); await responseGate; return providerResponse(); }, today: '2026-11-10' });
  await atProvider;
  const edit = await call(env, '/records/' + record.id, { method: 'PATCH', body: { revision: record.revision, input: { ...baseInput, amount: 99000 } } });
  assert.equal(edit.status, 200);
  release();
  const result = await (await work).json();
  assert.equal(result.stale, true); assert.equal(result.run.inputSnapshot.amount, 35000);
  assert.equal(result.record.input.amount, 99000); assert.equal(result.run.recordId, record.id);
  assert.match(JSON.stringify(result.run.plan.legalReview.facts), /35000/);
  assert.doesNotMatch(JSON.stringify(result.run.plan.legalReview.facts), /99000/);
  assert.equal(result.run.plan.contextAudit.status, 'passed');
});

test('a rejected candidate is not persisted and its audit remains bound to the original case', async (t) => {
  const env = { ...await setup(t), DEEPSEEK_API_KEY: 'mock-provider-key' };
  const record = await create(env, '拒绝候选的虚构案件');
  const other = await create(env, '不受影响的虚构案件');
  const sentinel = '本段候选内容只用于拒绝回写测试，不能出现在保存的方案中。';
  let calls = 0;
  const response = await call(env, `/records/${record.id}/analyze`, { method: 'POST', body: { revision: record.revision, attachmentIds: [] } }, { today: '2026-11-10', fetchImpl: async (_url, init) => {
    calls++;
    if (isContextAuditRequest(init)) {
      const rejected = passedAuditPayload(init);
      rejected.overall = 'blocked';
      rejected.sectionChecks.find(({ sectionId }) => sectionId === 'analysis').verdict = 'unsupported';
      return auditResponse(rejected);
    }
    const envelope = await providerResponse().json();
    const candidate = JSON.parse(envelope.choices[0].message.content);
    candidate.analysis = sentinel;
    envelope.choices[0].message.content = JSON.stringify(candidate);
    return new Response(JSON.stringify(envelope));
  } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(calls, 2);
  assert.equal(payload.plan.generation.mode, 'rules');
  assert.equal(payload.plan.contextAudit.status, 'blocked');
  assert.equal(payload.plan.ai, undefined);
  assert.equal(JSON.stringify(payload).includes(sentinel), false);
  const reloaded = (await (await call(env, '/records/' + record.id)).json()).record;
  assert.deepEqual(reloaded.runs[0].plan.contextAudit, payload.plan.contextAudit);
  assert.equal(JSON.stringify(reloaded).includes(sentinel), false);
  assert.equal((await (await call(env, '/records/' + other.id)).json()).record.runs.length, 0);
});

test('an audit reply cannot be replayed between cases even with identical input and candidate', async (t) => {
  const env = { ...await setup(t), DEEPSEEK_API_KEY: 'mock-provider-key' };
  const a = await create(env, '同案情A'); const b = await create(env, '同案情B');
  let previousAudit;
  const options = { today: '2026-11-10', fetchImpl: async (_url, init) => {
    if (!isContextAuditRequest(init)) return providerResponse();
    if (previousAudit) return auditResponse(previousAudit);
    previousAudit = passedAuditPayload(init);
    return auditResponse(previousAudit);
  } };
  const first = await (await call(env, `/records/${a.id}/analyze`, { method: 'POST', body: { revision: a.revision, attachmentIds: [] } }, options)).json();
  assert.equal(first.plan.contextAudit.status, 'passed');
  const second = await (await call(env, `/records/${b.id}/analyze`, { method: 'POST', body: { revision: b.revision, attachmentIds: [] } }, options)).json();
  assert.equal(second.plan.contextAudit.status, 'blocked');
  assert.equal(second.plan.ai, undefined);
  assert.notEqual(first.plan.contextAudit.contextId, second.plan.contextAudit.contextId);
  assert.deepEqual(first.run.inputSnapshot, second.run.inputSnapshot);
});

test('stale edits and duplicate in-flight analysis cannot overwrite a record', async (t) => {
  const env = { ...await setup(t), DEEPSEEK_API_KEY: 'mock-provider-key' };
  const record = await create(env, '并发项目');
  const saved = await call(env, '/records/' + record.id, { method: 'PATCH', body: { revision: 1, title: '第一次保存' } });
  assert.equal(saved.status, 200);
  assert.equal((await call(env, '/records/' + record.id, { method: 'PATCH', body: { revision: 1, title: '过期保存' } })).status, 409);
  assert.equal((await call(env, `/records/${record.id}/analyze`, { method: 'POST', body: { revision: 1 } })).status, 409);
  let started; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { started = resolve; });
  const options = { fetchImpl: async (_url, init) => { if (isContextAuditRequest(init)) return passedAuditResponse(init); started(); await gate; return providerResponse(); } };
  const pending = call(env, `/records/${record.id}/analyze`, { method: 'POST', body: { revision: 2 } }, options);
  await ready;
  assert.equal((await call(env, `/records/${record.id}/analyze`, { method: 'POST', body: { revision: 2 } }, options)).status, 409);
  release(); assert.equal((await pending).status, 200);
});

test('file failures and removed files are explicit and cannot enter later analysis', async (t) => {
  const env = await setup(t); const record = await create(env, '文件校验');
  const bad = new FormData(); bad.set('file', new File(['not an image'], 'fake.png', { type: 'image/png' }));
  assert.ok((await call(env, `/records/${record.id}/attachments`, { method: 'POST', body: bad })).status >= 400);
  const uploadResponse = await upload(env, record.id, '可以读取的项目文字。'); assert.equal(uploadResponse.status, 201);
  const data = await uploadResponse.json();
  const removed = await call(env, `/records/${record.id}/attachments/${data.attachment.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal((await call(env, `/records/${record.id}/attachments/${data.attachment.id}/content`)).status, 404);
  assert.equal((await call(env, `/records/${record.id}/analyze`, { method: 'POST', body: { revision: 3, attachmentIds: [data.attachment.id] } })).status, 404);
});

test('notes and archived records stay in their case, while legacy stateless analysis is disabled', async (t) => {
  const env = await setup(t); const record = await create(env, '跟进项目');
  const response = await call(env, `/records/${record.id}/notes`, { method: 'POST', body: { body: '虚构跟进：计划核对项目清单。' } });
  assert.equal(response.status, 201); const saved = await response.json();
  assert.equal(saved.note.recordId, record.id); assert.equal(saved.record.notes.length, 1);
  const archived = await call(env, '/records/' + record.id, { method: 'PATCH', body: { revision: 1, status: 'archived' } });
  assert.equal(archived.status, 200);
  assert.equal((await call(env, `/records/${record.id}/analyze`, { method: 'POST', body: { revision: 2 } })).status, 409);
  assert.equal((await call(env, '/plan', { method: 'POST', body: baseInput })).status, 409);
  const list = await (await call(env, '/records?status=archived')).json(); assert.equal(list.records[0].id, record.id);
});

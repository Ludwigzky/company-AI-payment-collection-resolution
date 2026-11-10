import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStorage } from '../src/local-storage.mjs';
import { handleAPI } from '../src/api.js';

const ORIGIN = 'https://overview.example';
const TODAY = '2026-11-10';
function request(path, { owner = 'alice', method = 'GET', body, origin = ORIGIN } = {}) {
  return new Request(ORIGIN + '/api' + path, { method, headers: { Origin: origin, ...(owner ? { 'oai-authenticated-user-id': owner } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function fixture(t) { const storage = await createLocalStorage({ memory: true }); t.after(() => storage.close()); return storage; }
const invoke = (env, path, options) => handleAPI(request(path, options), env, { today: TODAY, fetchImpl() { throw new Error('Overview must never call the model.'); } });
async function createCase(env, name, owner = 'alice') {
  const response = await invoke(env, '/records', { owner, method: 'POST', body: { title: name, input: { debtorName: name, amount: 900000, dueDate: '2020-01-01', issueText: '虚构测试：金额和日期只是案件填报，不能自动形成应收台账。' } } });
  assert.equal(response.status, 201); return (await response.json()).record;
}
const data = () => ({
  title: '独立付款节点', status: 'active', currency: 'CNY', invoiceStatus: 'recorded',
  invoices: [{ number: 'TEST-INVOICE-001', issuedOn: '2026-10-15', amount: 500, status: 'issued' }],
  finance: { status: 'confirmed', recognizedOn: '2026-10-01', agingStartOn: '2026-10-01', balance: 300, asOf: TODAY, reference: '虚构财务确认凭证' },
  payment: { status: 'confirmed', unpaidAmount: 100, asOf: TODAY, originalDueOn: '2026-11-20', currentDueOn: '2026-11-20', basis: '虚构合同付款节点原文' },
});

test('overview routes enforce identity and same-origin before any records are returned', async (t) => {
  const env = await fixture(t);
  assert.equal((await invoke(env, '/overview', { owner: '' })).status, 401);
  assert.equal((await invoke(env, '/overview', { origin: 'https://foreign.example' })).status, 403);
  const result = await (await invoke(env, '/overview')).json();
  assert.equal(result.summary.recordCount, 0);
  assert.deepEqual(result.ledgers, []);
});

test('the integrated overview keeps invoicing, financial aging and payment maturity independent through edits and archive', async (t) => {
  const env = await fixture(t);
  const record = await createCase(env, '甲公司项目');
  await createCase(env, '乙公司项目', 'bob');
  let overview = await (await invoke(env, '/overview')).json();
  assert.equal(overview.summary.recordsWithoutLedgerCount, 1);
  assert.equal(overview.ledgers.length, 0, 'case amount must not seed a ledger');
  const saved = await invoke(env, '/overview/ledgers', { method: 'POST', body: { recordId: record.id, data: data() } });
  assert.equal(saved.status, 201);
  const ledger = (await saved.json()).ledger;
  overview = await (await invoke(env, '/overview')).json();
  assert.equal(overview.summary.recordCount, 1, 'another account is absent');
  assert.equal(overview.summary.invoiceNetAmount, 500);
  assert.equal(overview.summary.financeBalance, 300);
  assert.equal(overview.summary.paymentUnpaidAmount, 100);
  assert.equal(overview.ledgers[0].metrics.agingDays, 40);
  assert.equal(overview.ledgers[0].metrics.overdueDays, 0);
  assert.equal(overview.ledgers[0].metrics.maturity, 'not_due');
  assert.equal(overview.summary.overdueAmount, 0);
  const changedData = structuredClone(ledger.data);
  changedData.payment.currentDueOn = '2026-11-01';
  const updated = await invoke(env, '/overview/ledgers/' + ledger.id, { method: 'PATCH', body: { revision: ledger.revision, data: changedData, changeReason: '虚构补充协议：明确当前到期日，保留原日。' } });
  assert.equal(updated.status, 200);
  overview = await (await invoke(env, '/overview')).json();
  assert.equal(overview.ledgers[0].metrics.agingDays, 40);
  assert.equal(overview.ledgers[0].metrics.overdueDays, 9);
  assert.equal(overview.summary.overdueAmount, 100);
  const history = (await (await invoke(env, '/overview/ledgers/' + ledger.id + '/history')).json()).history;
  assert.equal(history.length, 2);
  assert.ok(history.some((item) => item.data.payment.currentDueOn === '2026-11-20'));
  const archive = await invoke(env, '/records/' + record.id, { method: 'PATCH', body: { revision: record.revision, status: 'archived' } });
  assert.equal(archive.status, 200);
  overview = await (await invoke(env, '/overview')).json();
  assert.equal(overview.summary.financeBalance, 300, 'archiving a case is not settling the balance');
  assert.equal(overview.summary.overdueAmount, 100);
  const activeOnly = await (await invoke(env, '/overview?caseStatus=active')).json();
  assert.equal(activeOnly.ledgers.length, 0);
  assert.equal((await invoke(env, '/overview/ledgers/' + ledger.id + '/history', { owner: 'bob' })).status, 404);
});

test('legal timeline archives occurrence and delivery separately, keeps corrections and never derives a legal deadline', async (t) => {
  const env = await fixture(t);
  const record = await createCase(env, '法律事项测试');
  const originalData = { type: 'collection', eventOn: '2026-10-01', title: '虚构催告', description: '仅录入事实，法律效果待核验。', deliveryStatus: 'served', servedOn: '2026-10-03', reminderOn: '2026-11-01', evidenceNote: '待核原始送达凭证' };
  const response = await invoke(env, '/overview/legal-events', { method: 'POST', body: { recordId: record.id, data: originalData } });
  assert.equal(response.status, 201);
  const original = (await response.json()).legalEvent;
  let overview = await (await invoke(env, '/overview')).json();
  assert.equal(overview.legalEvents[0].data.eventOn, '2026-10-01');
  assert.equal(overview.legalEvents[0].data.servedOn, '2026-10-03');
  assert.ok(overview.timeline.some((row) => row.eventId === original.id && row.source === 'legal_delivery' && row.date === '2026-10-03'));
  assert.equal(overview.legalEvents[0].data.deadlineOn, '');
  assert.equal(overview.summary.deadlinesOverdueCount, 0);
  assert.equal(overview.summary.remindersOverdueCount, 1);
  const corrected = await invoke(env, '/overview/legal-events', { method: 'POST', body: { recordId: record.id, supersedesId: original.id, data: { ...originalData, servedOn: '2026-10-04', reminderOn: '2026-11-20' } } });
  assert.equal(corrected.status, 201);
  overview = await (await invoke(env, '/overview')).json();
  assert.equal(overview.legalEvents.length, 2);
  assert.equal(overview.summary.supersededLegalEventCount, 1);
  assert.equal(overview.summary.remindersOverdueCount, 0, 'a corrected old reminder is retained but not counted as current');
  assert.ok(overview.timeline.some((row) => row.eventId === original.id && row.superseded));
  assert.ok(overview.timeline.some((row) => row.source === 'case_input' && row.type === 'dueDate' && !row.deadlineOn));
});

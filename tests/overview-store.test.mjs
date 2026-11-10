import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalStorage } from '../src/local-storage.mjs';
import { RecordError, createRecord, updateRecord, addAttachment, removeAttachment, addNote, saveRun } from '../src/records.js';
import { createLedger, updateLedger, getLedgerHistory, createLegalEvent, getOverview, validateLedgerData, validateLegalEventData, handleOverviewAPI } from '../src/overview-store.js';

const today = '2026-11-10';
const owner = 'alice';
async function setup(t) { const env = await createLocalStorage({ memory: true }); t.after(() => env.close()); return env; }
const rejectStatus = (operation, status) => assert.rejects(operation, (error) => error instanceof RecordError && error.status === status);
const ledgerData = (overrides = {}) => ({ title: '项目应收', invoiceStatus: 'recorded', invoices: [{ id: 'invoice-a', number: '', issuedOn: '2026-09-01', amount: 110, status: 'issued' }],
  finance: { status: 'confirmed', recognizedOn: '2026-08-01', agingStartOn: '2026-08-01', balance: 80, asOf: today, reference: '会计应收明细' },
  payment: { status: 'confirmed', unpaidAmount: 60, asOf: today, originalDueOn: '2026-09-01', currentDueOn: '2026-10-01', basis: '双方书面确认' }, ...overrides });
const eventData = (overrides = {}) => ({ type: 'collection', eventOn: '2026-10-01', title: '催收函', ...overrides });
const attachment = () => ({ name: '证据.txt', mime: 'text/plain', size: 10, sha256: 'a'.repeat(64), objectKey: `private/${crypto.randomUUID()}` });
const req = (path, { method = 'GET', body, identity = owner, headers = {} } = {}) => new Request('https://workspace.example/api/overview' + path, {
  method, headers: { ...(identity ? { 'oai-authenticated-user-id': identity } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const call = (env, path = '', options) => handleOverviewAPI(req(path, options), env, { today });

test('separate invoice, finance and payment values survive drafts and never derive from case amounts', async (t) => {
  const env = await setup(t);
  const record = await createRecord(env, owner, { title: '一个案件', input: { amount: 999999, dueDate: '2025-01-01' } });
  const draft = await createLedger(env, owner, { recordId: record.id, data: {} });
  assert.equal(draft.data.finance.balance, null);
  assert.equal(draft.data.payment.unpaidAmount, null);
  assert.equal(draft.data.invoiceStatus, 'unconfirmed');
  assert.equal(draft.data.payment.originalDueOn, '');
  const saved = await createLedger(env, owner, { recordId: record.id, data: ledgerData() });
  assert.equal(saved.data.invoices[0].amount, 110);
  assert.equal(saved.data.finance.balance, 80);
  assert.equal(saved.data.payment.unpaidAmount, 60);
  const view = await getOverview(env, owner, {}, today);
  const metrics = view.ledgers.find(({ id }) => id === saved.id).metrics;
  assert.equal(metrics.invoiceNetAmount, 110);
  assert.equal(metrics.financeBalance, 80);
  assert.equal(metrics.paymentUnpaidAmount, 60);
  assert.equal(view.ledgers.find(({ id }) => id === draft.id).metrics.financeKnown, false);
  assert.equal((await getLedgerHistory(env, owner, saved.id)).length, 1);
});

test('strict whitelist, real dates, safe cents, invoice identities and confirmed evidence are validated', () => {
  for (const data of [{ ownerId: 'bob' }, { finance: { apiKey: 'secret' } }, { title: '字'.repeat(161) }, { currency: 'USD' }, { invoices: Array(31).fill({}) },
    { invoiceStatus: 'recorded' }, { status: 'voided' }, { invoices: [{ issuedOn: '2026-02-30', amount: 1 }] }, { invoices: [{ issuedOn: '', amount: 1 }] },
    { invoices: [{ id: 'same', issuedOn: '2026-01-01', amount: 1 }, { id: 'same', issuedOn: '2026-01-01', amount: 1 }] },
    { finance: { status: 'confirmed', balance: 0 } }, { payment: { status: 'confirmed', unpaidAmount: 0 } }]) assert.throws(() => validateLedgerData(data), RecordError);
  for (const balance of [-1, 0.001, 1.000000001, NaN, Infinity, '123', 90071992547410]) assert.throws(() => validateLedgerData({ finance: { balance } }), RecordError);
  for (const balance of [null, '', 0, 0.01, 88.88]) assert.equal(validateLedgerData({ finance: { balance } }).finance.balance, balance === '' ? null : balance);
  const generated = validateLedgerData({ invoices: [{ issuedOn: '2026-01-01', amount: 0 }] });
  assert.match(generated.invoices[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(generated.invoices[0].number, '');
  assert.equal(validateLedgerData({ finance: { recognizedOn: '2199-12-31' } }).finance.recognizedOn, '2199-12-31');
  for (const event of [{ ...eventData(), model: 'provider' }, eventData({ eventOn: '2026-02-30' }), eventData({ verification: 'reviewed' }),
    eventData({ eventOn: '', verification: 'reviewed', reviewer: '核验人', reviewedOn: today, evidenceNote: '仅内容已核对' }),
    eventData({ deliveryStatus: 'served' }), eventData({ deliveryStatus: 'served', servedOn: '2026-11-11' }), eventData({ deadlineOn: '2026-11-12' }), eventData({ attachmentIds: ['same', 'same'] })]) assert.throws(() => validateLegalEventData(event, today), RecordError);
});

test('unknown legal event dates stay blank and pending without inventing today as occurrence date', async (t) => {
  const env = await setup(t); const record = await createRecord(env, owner);
  for (const eventOn of ['', undefined]) {
    const event = await createLegalEvent(env, owner, { recordId: record.id, data: eventData({ eventOn, reviewer: '待补核验人', reviewedOn: today }) }, today);
    assert.equal(event.data.eventOn, '');
    assert.equal(event.data.verification, 'pending');
    const stored = (await getOverview(env, owner, {}, today)).legalEvents.find(({ id }) => id === event.id);
    assert.equal(stored.data.eventOn, '');
    assert.equal(stored.data.verification, 'pending');
  }
});

test('zero net issued and red-offset invoices remain invoiced history rather than never issued', () => {
  const invoices = [{ id: 'issued', issuedOn: '2026-09-01', amount: 100, status: 'issued' }, { id: 'red', issuedOn: '2026-10-01', amount: 100, status: 'red_offset' }];
  assert.throws(() => validateLedgerData({ invoiceStatus: 'not_issued', invoices }), RecordError);
  assert.throws(() => validateLedgerData({ invoiceStatus: 'not_issued', invoices: [{ ...invoices[0], amount: 0 }] }), RecordError);
  assert.equal(validateLedgerData({ invoiceStatus: 'recorded', invoices }).invoices.length, 2);
  assert.equal(validateLedgerData({ invoiceStatus: 'not_issued', invoices: [{ ...invoices[0], status: 'voided' }] }).invoiceStatus, 'not_issued');
});

test('owner and parent boundaries protect ledgers, history, corrections, and attachments', async (t) => {
  const env = await setup(t);
  const a = await createRecord(env, owner); const a2 = await createRecord(env, owner); const b = await createRecord(env, 'bob');
  const l = await createLedger(env, owner, { recordId: a.id, data: ledgerData() });
  const foreign = await createLedger(env, 'bob', { recordId: b.id, data: {} });
  const file = await addAttachment(env, owner, a.id, attachment()); const otherFile = await addAttachment(env, owner, a2.id, attachment());
  const event = await createLegalEvent(env, owner, { recordId: a.id, ledgerId: l.id, data: eventData({ attachmentIds: [file.id] }) }, today);
  for (const operation of [() => createLedger(env, 'bob', { recordId: a.id, data: {} }), () => getLedgerHistory(env, 'bob', l.id),
    () => updateLedger(env, 'bob', l.id, { revision: 1, data: {} }), () => createLegalEvent(env, owner, { recordId: a.id, ledgerId: foreign.id, data: eventData() }, today),
    () => createLegalEvent(env, owner, { recordId: a2.id, ledgerId: l.id, data: eventData() }, today),
    () => createLegalEvent(env, owner, { recordId: a2.id, supersedesId: event.id, data: eventData() }, today),
    () => createLegalEvent(env, owner, { recordId: a.id, supersedesId: event.id, data: eventData() }, today),
    () => createLegalEvent(env, owner, { recordId: a.id, data: eventData({ attachmentIds: [otherFile.id] }) }, today)]) await rejectStatus(operation, 404);
  await removeAttachment(env, owner, a.id, file.id);
  await rejectStatus(() => createLegalEvent(env, owner, { recordId: a.id, data: eventData({ attachmentIds: [file.id] }) }, today), 404);
  assert.deepEqual((await getOverview(env, owner, {}, today)).legalEvents[0].data.attachmentIds, [file.id], 'prior evidence linkage survives soft removal');
  assert.equal((await getOverview(env, 'bob', {}, today)).ledgers.length, 1);
  assert.throws(() => env.DB.database.prepare('INSERT INTO recovery_receivable_history (id,owner_id,record_id,receivable_id,revision,data_json,change_reason,created_at) VALUES (?,?,?,?,?,?,?,?)').run('bad', 'bob', b.id, l.id, 99, '{}', '', today), /FOREIGN KEY/);
});

test('each committed revision is audited and original payment date correction requires a reason', async (t) => {
  const env = await setup(t); const record = await createRecord(env, owner);
  const initial = await createLedger(env, owner, { recordId: record.id, data: ledgerData() });
  const revisedData = ledgerData({ payment: { ...initial.data.payment, currentDueOn: '2026-12-01' } });
  const revised = await updateLedger(env, owner, initial.id, { revision: 1, data: revisedData, changeReason: '双方延期书面确认' });
  assert.equal(revised.data.payment.originalDueOn, '2026-09-01');
  assert.equal(revised.data.payment.currentDueOn, '2026-12-01');
  const changedOriginal = { ...revised.data, payment: { ...revised.data.payment, originalDueOn: '2026-08-31' } };
  await rejectStatus(() => updateLedger(env, owner, initial.id, { revision: 2, data: changedOriginal }), 400);
  const correction = await updateLedger(env, owner, initial.id, { revision: 2, data: changedOriginal, changeReason: '核对原合同纠正录入日期' });
  assert.equal(correction.revision, 3);
  const history = await getLedgerHistory(env, owner, initial.id);
  assert.deepEqual(history.map(({ revision }) => revision), [3, 2, 1]);
  assert.equal(history[2].data.payment.originalDueOn, '2026-09-01');
  assert.equal(history[0].data.payment.originalDueOn, '2026-08-31');
  assert.equal(history[0].changeReason, '核对原合同纠正录入日期');
  for (const sql of ['UPDATE recovery_receivable_history SET change_reason = \'覆盖\'', 'DELETE FROM recovery_receivable_history']) assert.throws(() => env.DB.database.exec(sql), /immutable/);
});

test('simultaneous stale saves and failed audit writes leave no orphan snapshots or partial ledger updates', async (t) => {
  const env = await setup(t); const record = await createRecord(env, owner);
  const initial = await createLedger(env, owner, { recordId: record.id, data: {} });
  const writes = await Promise.allSettled([updateLedger(env, owner, initial.id, { revision: 1, data: { title: '甲' } }), updateLedger(env, owner, initial.id, { revision: 1, data: { title: '乙' } })]);
  assert.equal(writes.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(writes.find(({ status }) => status === 'rejected').reason.status, 409);
  assert.equal((await getLedgerHistory(env, owner, initial.id)).length, 2);
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = (statements) => {
    const update = statements.find((statement) => /^UPDATE recovery_receivables/.test(statement.sql));
    if (update) update.execute = () => { throw new Error('injected write failure'); };
    return batch(statements);
  };
  await assert.rejects(() => updateLedger(env, owner, initial.id, { revision: 2, data: { title: '应回滚' } }), /injected/);
  assert.equal((await getLedgerHistory(env, owner, initial.id)).length, 2);
  const saved = (await getOverview(env, owner, {}, today)).ledgers[0];
  assert.equal(saved.revision, 2);
  assert.notEqual(saved.data.title, '应回滚');
  env.DB.batch = (statements) => {
    const history = statements.find((statement) => /^INSERT INTO recovery_receivable_history/.test(statement.sql));
    if (history) history.execute = () => { throw new Error('injected audit failure'); };
    return batch(statements);
  };
  await assert.rejects(() => createLedger(env, owner, { recordId: record.id, data: {} }), /injected audit/);
  assert.equal((await getOverview(env, owner, {}, today)).ledgers.length, 1, 'failed history creation rolls back its parent ledger');
});

test('archiving between initial read and transactional save cannot append a ledger revision', async (t) => {
  const env = await setup(t); const record = await createRecord(env, owner);
  const l = await createLedger(env, owner, { recordId: record.id, data: {} });
  const batch = env.DB.batch.bind(env.DB);
  let archived = false;
  env.DB.batch = (statements) => {
    if (!archived && statements.some((statement) => /^INSERT INTO recovery_receivable_history/.test(statement.sql))) {
      archived = true;
      env.DB.database.prepare("UPDATE recovery_records SET status = 'archived' WHERE owner_id = ? AND id = ?").run(owner, record.id);
    }
    return batch(statements);
  };
  await rejectStatus(() => updateLedger(env, owner, l.id, { revision: 1, data: { title: '竞态保存' } }), 409);
  assert.equal((await getLedgerHistory(env, owner, l.id)).length, 1);
  assert.equal((await getOverview(env, owner, {}, today)).ledgers[0].revision, 1);
});

test('archive is read only, preserves balances by default, and is not a settlement flag', async (t) => {
  const env = await setup(t); const record = await createRecord(env, owner);
  const l = await createLedger(env, owner, { recordId: record.id, data: ledgerData() });
  const event = await createLegalEvent(env, owner, { recordId: record.id, data: eventData() }, today);
  await updateRecord(env, owner, record.id, { revision: 1, status: 'archived' });
  for (const operation of [() => createLedger(env, owner, { recordId: record.id, data: {} }), () => updateLedger(env, owner, l.id, { revision: 1, data: {} }),
    () => createLegalEvent(env, owner, { recordId: record.id, data: eventData() }, today), () => createLegalEvent(env, owner, { recordId: record.id, supersedesId: event.id, data: eventData() }, today)]) await rejectStatus(operation, 409);
  assert.equal((await getOverview(env, owner, {}, today)).ledgers[0].data.finance.balance, 80);
  assert.equal((await getOverview(env, owner, { caseStatus: 'active' }, today)).ledgers.length, 0);
  assert.equal((await getOverview(env, owner, { caseStatus: 'archived' }, today)).ledgers.length, 1);
  assert.equal((await getLedgerHistory(env, owner, l.id)).length, 1);
});

test('legal events append correction chains, retain timestamps, and never synthesize a legal deadline', async (t) => {
  const env = await setup(t); const record = await createRecord(env, owner);
  const first = await createLegalEvent(env, owner, { recordId: record.id, data: eventData({ reminderOn: '2026-11-15' }) }, today);
  assert.equal(first.data.deadlineOn, '');
  assert.equal(first.data.deadlineBasis, '');
  const next = await createLegalEvent(env, owner, { recordId: record.id, supersedesId: first.id, data: eventData({ title: '更正催收事件', verification: 'reviewed', reviewer: '张律师', reviewedOn: today, evidenceNote: '已核对送达回执', deliveryStatus: 'served', servedOn: '2026-10-02', deadlineOn: '2026-12-01', deadlineBasis: '人工核定依据', deadlineReviewer: '张律师', deadlineReviewedOn: today }) }, today);
  await rejectStatus(() => createLegalEvent(env, owner, { recordId: record.id, supersedesId: first.id, data: eventData() }, today), 409);
  const last = await createLegalEvent(env, owner, { recordId: record.id, supersedesId: next.id, data: eventData({ title: '再次更正' }) }, today);
  const view = await getOverview(env, owner, {}, today);
  assert.equal(view.legalEvents.length, 3);
  assert.equal(view.legalEvents.find(({ id }) => id === first.id).createdAt, first.createdAt);
  assert.equal(view.legalEvents.find(({ id }) => id === last.id).supersedesId, next.id);
  for (const sql of ['UPDATE recovery_legal_events SET data_json = \'{}\'', 'DELETE FROM recovery_legal_events']) assert.throws(() => env.DB.database.exec(sql), /append only/);
});

test('overview filters literal search, includes safe case inputs and notes, and has no silent first-200 cap', async (t) => {
  const env = await setup(t);
  for (let index = 0; index < 205; index++) await createRecord(env, owner, { title: `案件${index}`, input: { debtorName: `客户${index}` } });
  const special = await createRecord(env, owner, { title: '查询100%_案件', input: { companyName: '供应商', contractDate: '2026-05-01', legalFactDate: '2026-06-01' } });
  await createRecord(env, 'bob', { title: '秘密案件' });
  await createLedger(env, owner, { recordId: special.id, data: ledgerData() });
  await addNote(env, owner, special.id, { body: '当前案件跟进' });
  await addAttachment(env, owner, special.id, attachment());
  await saveRun(env, owner, special.id, { revision: 1, inputSnapshot: special.input, attachmentIds: [], plan: { secret: '大段模型输出' } });
  const all = await getOverview(env, owner, {}, today);
  assert.equal(all.records.length, 206);
  const only = await getOverview(env, owner, { q: '100%_' }, today);
  assert.deepEqual(only.records.map(({ id }) => id), [special.id]);
  assert.equal(only.records[0].input.contractDate, '2026-05-01');
  assert.equal(only.records[0].notes[0].body, '当前案件跟进');
  assert.equal(JSON.stringify(only).includes('objectKey'), false);
  assert.equal(JSON.stringify(only).includes('大段模型输出'), false);
  assert.deepEqual((await getOverview(env, owner, { q: '项目应收' }, today)).records.map(({ id }) => id), [special.id]);
  assert.equal((await getOverview(env, owner, { recordId: all.records.find(({ id }) => id !== special.id).id }, today)).ledgers.length, 0);
  const picker = await (await call(env, '/records')).json();
  assert.equal(picker.records.length, 206);
  assert.equal(picker.records[0].notes, undefined);
});

test('HTTP routes require trusted identity, reject malformed and oversized bodies, and expose stable envelopes', async (t) => {
  const env = await setup(t); const record = await createRecord(env, owner);
  assert.equal((await call(env, '', { identity: '' })).status, 401);
  const local = await handleOverviewAPI(req('', { identity: '' }), env, { localOwnerId: owner, today });
  assert.equal(local.status, 200);
  const response = await call(env, '/ledgers', { method: 'POST', body: { recordId: record.id, data: ledgerData() } });
  assert.equal(response.status, 201); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const { ledger } = await response.json();
  assert.equal((await call(env, `/ledgers/${ledger.id}`, { method: 'PATCH', body: { revision: 1, data: {}, changeReason: '核对后清空原付款日待确认' } })).status, 200);
  assert.equal((await call(env, `/ledgers/${ledger.id}`, { method: 'PATCH', body: { revision: 1, data: {} } })).status, 409);
  assert.equal((await (await call(env, `/ledgers/${ledger.id}/history`)).json()).history.length, 2);
  assert.equal((await call(env, '/legal-events', { method: 'POST', body: { recordId: record.id, data: eventData() } })).status, 201);
  assert.equal((await call(env, '', { method: 'POST', body: {} })).status, 405);
  assert.equal((await call(env, '/legal-events/missing', { method: 'PATCH', body: {} })).status, 404);
  const malformed = new Request('https://workspace.example/api/overview/ledgers', { method: 'POST', headers: { 'Content-Type': 'application/json', 'oai-authenticated-user-id': owner }, body: '{' });
  assert.equal((await handleOverviewAPI(malformed, env)).status, 400);
  assert.equal((await call(env, '/ledgers', { method: 'POST', body: { recordId: record.id, data: { note: '字'.repeat(65000) } } })).status, 413);
  assert.equal((await call(env, '/ledgers', { method: 'POST', body: { recordId: record.id, data: {}, ownerId: 'bob' } })).status, 400);
  assert.equal((await call(env, '?caseStatus=settled')).status, 400);
});

test('new migrations upgrade an existing local database and durable ledgers/events reopen unchanged', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'overview-store-'));
  const legacy = new DatabaseSync(join(directory, 'records.sqlite'));
  legacy.exec(readFileSync(new URL('../drizzle/0000_military_nomad.sql', import.meta.url), 'utf8'));
  legacy.exec('CREATE TABLE _local_migrations (tag TEXT PRIMARY KEY)');
  legacy.prepare('INSERT INTO _local_migrations(tag) VALUES (?)').run('0000_military_nomad');
  legacy.prepare('INSERT INTO recovery_records (id,owner_id,number,title,input_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('legacy-record', owner, 'RC-OLD', '旧版案件', '{}', today, today);
  legacy.close();
  let env = await createLocalStorage({ directory });
  t.after(() => { env.close(); for (const name of readdirSync(directory)) rmSync(join(directory, name), { force: true }); rmdirSync(directory); });
  const record = await createRecord(env, owner, { title: '持久化总览' });
  assert.ok((await getOverview(env, owner, {}, today)).records.some(({ id }) => id === 'legacy-record'));
  const ledger = await createLedger(env, owner, { recordId: record.id, data: ledgerData() });
  await updateLedger(env, owner, ledger.id, { revision: 1, data: { ...ledger.data, note: '已保存修订' }, changeReason: '补充说明' });
  await createLegalEvent(env, owner, { recordId: record.id, ledgerId: ledger.id, data: eventData() }, today);
  const before = await getOverview(env, owner, {}, today); const beforeHistory = await getLedgerHistory(env, owner, ledger.id);
  const expectedMigrations = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')).entries.map(({ tag }) => tag).sort();
  assert.deepEqual(env.DB.database.prepare('SELECT tag FROM _local_migrations ORDER BY tag').all().map(({ tag }) => tag), expectedMigrations);
  env.close(); env = await createLocalStorage({ directory });
  assert.deepEqual(await getOverview(env, owner, {}, today), before);
  assert.deepEqual(await getLedgerHistory(env, owner, ledger.id), beforeHistory);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverview } from '../src/overview-metrics.js';

const TODAY = '2026-11-10';
const record = (id = 'r1', patch = {}) => ({ id, number: `RC-${id}`, title: '回款事项', status: 'active', input: { amount: 999999, dueDate: '2020-01-01' }, ...patch });
function ledger(id = 'l1', patch = {}, recordId = 'r1') {
  return { id, recordId, revision: 1, createdAt: '2026-11-01T01:00:00.000Z', updatedAt: '2026-11-01T01:00:00.000Z', data: {
    title: '第一期款', status: 'active', currency: 'CNY', invoiceStatus: 'recorded',
    invoices: [{ id: 'i1', number: 'INV-1', issuedOn: '2026-10-01', amount: 100, status: 'issued' }],
    finance: { status: 'confirmed', recognizedOn: '2026-09-01', agingStartOn: '2026-10-01', balance: 70, asOf: '2026-11-09', reference: '财务台账2026-11' },
    payment: { status: 'confirmed', unpaidAmount: 80, asOf: '2026-11-09', originalDueOn: '2026-11-01', currentDueOn: '2026-11-05', basis: '双方书面确认节点' }, ...patch,
  } };
}
function event(id = 'e1', patch = {}, top = {}) {
  return { id, recordId: 'r1', ledgerId: 'l1', supersedesId: null, createdAt: '2026-11-02T01:00:00.000Z', ...top, data: {
    type: 'collection', eventOn: '2026-11-01', title: '书面催告', description: '人工填报', deliveryStatus: 'unknown', servedOn: '', evidenceNote: '', attachmentIds: [],
    verification: 'pending', reviewer: '', reviewedOn: '', reminderOn: '', deadlineOn: '', deadlineBasis: '', deadlineReviewer: '', deadlineReviewedOn: '', ...patch,
  } };
}
function overview(ledgers = [ledger()], legalEvents = [], records = [record()]) { return buildOverview({ records, ledgers, legalEvents }, TODAY); }

test('invoices, finance balances, payment snapshots and case claims remain separate', () => {
  const result = overview();
  const m = result.ledgers[0].metrics;
  assert.equal(m.invoiceNetAmount, 100);
  assert.equal(m.financeBalance, 70);
  assert.equal(m.paymentUnpaidAmount, 80);
  assert.equal(m.agingDays, 40);
  assert.equal(m.overdueDays, 5);
  assert.equal(result.summary.financeBalance, 70);
  assert.equal(result.summary.overdueAmount, 80);
  assert.equal(result.summary.statusCounts.finance.confirmed, 1);
  assert.equal(m.financeSnapshotAgeDays, 1);
  assert.equal(m.paymentSnapshotAgeDays, 1);
  assert.match(m.financeFreshnessLabel, /截至2026-11-09/);
});

test('case values and dates never seed ledgers or fabricate balances or legal deadlines', () => {
  const result = overview([], [], [record('r1', { input: { amount: 1000000, dueDate: '2020-01-01', contractDate: '2019-01-01' } })]);
  assert.equal(result.ledgers.length, 0);
  assert.equal(result.summary.recordsWithoutLedgerCount, 1);
  assert.equal(result.summary.activeLedgerCount, 0);
  assert.equal(result.summary.deadlinesOverdueCount, 0);
  assert.equal(result.timeline.length, 2);
  assert.ok(result.timeline.every((row) => row.source === 'case_input' && row.verificationLabel === '填报日期未核实' && row.deadlineOn === null));
});

test('invoice arithmetic uses cents, subtracts red offsets, skips voids and permits signed net amounts', () => {
  const l = ledger('l1', { invoices: [
    { status: 'issued', issuedOn: '2026-01-01', amount: 0.1 }, { status: 'issued', issuedOn: '2026-01-01', amount: 0.2 },
    { status: 'red_offset', issuedOn: '2026-02-01', amount: 0.05 }, { status: 'voided', issuedOn: 'invalid', amount: Infinity },
  ] });
  const result = overview([l]);
  assert.equal(result.summary.invoiceNetCents, 25);
  assert.equal(result.summary.invoiceNetAmount, 0.25);
  l.data.invoices = [{ status: 'red_offset', issuedOn: '2026-01-01', amount: 10 }];
  assert.equal(overview([l]).summary.invoiceNetAmount, -10);
});

test('unknown invoices and contradictory not-issued detail remain unknown, explicit not-issued is zero', () => {
  const unknown = ledger('u', { invoiceStatus: 'unconfirmed' });
  const contradictory = ledger('c', { invoiceStatus: 'not_issued' });
  const noInvoice = ledger('n', { invoiceStatus: 'not_issued', invoices: [] });
  const result = overview([unknown, contradictory, noInvoice]);
  assert.equal(result.summary.invoiceUnknownCount, 2);
  assert.equal(result.summary.invoiceKnownCount, 1);
  assert.equal(result.summary.invoiceNetAmount, 0);
  assert.equal(result.ledgers[0].metrics.invoiceNetAmount, null);
  assert.equal(result.ledgers[1].metrics.invoiceNetAmount, null);
  assert.equal(overview([unknown]).summary.invoiceNetAmount, null);
  const reversed = ledger('reversed', { invoiceStatus: 'not_issued', invoices: [
    { status: 'issued', issuedOn: '2026-10-01', amount: 100 },
    { status: 'red_offset', issuedOn: '2026-10-02', amount: 100 },
  ] });
  assert.equal(overview([reversed]).ledgers[0].metrics.invoiceKnown, false, 'zero net does not mean no invoice was ever issued');
});

test('missing or future aging dates preserve known financial balance and report amount coverage', () => {
  const a = ledger('a'); a.data.finance.agingStartOn = '';
  const b = ledger('b'); b.data.finance.agingStartOn = '2026-11-10';
  const c = ledger('c'); c.data.finance.status = 'unconfirmed';
  const result = overview([a, b, c]);
  assert.equal(result.summary.financeBalance, 140);
  assert.equal(result.summary.financeKnownCount, 2);
  assert.equal(result.summary.agingKnownCount, 0);
  assert.equal(result.summary.agingUnknownCount, 3);
  assert.equal(result.summary.agingUnknownAmount, 140);
  assert.equal(result.summary.agingAmountKnownCount, 2);
  assert.equal(result.summary.agingAmountUnknownCount, 1);
  assert.equal(result.ledgers[0].metrics.agingDays, null);
  const unknown = result.buckets.aging.find((bucket) => bucket.key === 'unknown');
  assert.equal(unknown.amount, 140);
  assert.equal(unknown.amountKnownCount, 2);
  assert.equal(unknown.amountUnknownCount, 1);
});

test('future and inconsistent finance snapshot dates are excluded, independently of payment', () => {
  const invalids = [
    { asOf: '2026-11-11' }, { recognizedOn: '2026-11-10' }, { recognizedOn: '2026-02-30' }, { reference: '' }, { balance: null },
  ].map((patch, index) => { const l = ledger(`l${index}`); Object.assign(l.data.finance, patch); return l; });
  const result = overview(invalids);
  assert.equal(result.summary.financeKnownCount, 0);
  assert.equal(result.summary.financeBalance, null);
  assert.equal(result.summary.paymentUnpaidAmount, 400);
  assert.ok(result.ledgers.every((l) => l.metrics.agingDays === null && l.metrics.financeBalance === null));
});

test('explicit nonrecognition is separate from missing finance data and has no applicable aging', () => {
  const notRecognized = ledger('n'); notRecognized.data.finance.status = 'not_recognized';
  const unconfirmed = ledger('u'); unconfirmed.data.finance.status = 'unconfirmed';
  const result = overview([notRecognized, unconfirmed]);
  assert.equal(result.summary.financeNotRecognizedCount, 1);
  assert.equal(result.summary.financeUnknownCount, 1);
  assert.equal(result.summary.agingUnknownCount, 1);
  assert.equal(result.summary.agingNotApplicableCount, 1);
  assert.equal(result.ledgers[0].metrics.agingBucket, null);
  assert.equal(result.ledgers[0].metrics.agingReason, '本节点未确认为财务应收，不计算账龄');
  assert.equal(result.buckets.aging.find((b) => b.key === 'unknown').count, 1);
  assert.equal(overview([notRecognized]).summary.financeBalance, 0);
  assert.equal(overview([notRecognized]).summary.financeUnknownCount, 0);
});

test('maturity distinguishes future, today, overdue, unknown and explicit zero', () => {
  const make = (id, patch) => { const l = ledger(id); Object.assign(l.data.payment, patch); return l; };
  const result = overview([
    make('future', { currentDueOn: '2026-11-11' }), make('today', { currentDueOn: TODAY }), make('old', { currentDueOn: '2026-11-09' }),
    make('unknown', { currentDueOn: '' }), make('conditional', { status: 'conditional' }), make('zero', { unpaidAmount: 0 }),
  ]);
  assert.deepEqual(result.ledgers.map((l) => l.metrics.maturity), ['not_due', 'due_today', 'overdue', 'unknown', 'unknown', 'no_unpaid']);
  assert.deepEqual(result.ledgers.map((l) => l.metrics.overdueDays), [0, 0, 1, null, null, null]);
  assert.equal(result.summary.notDueAmount, 80);
  assert.equal(result.summary.dueTodayAmount, 80);
  assert.equal(result.summary.overdueAmount, 80);
  assert.equal(result.summary.paymentUnpaidAmount, 240);
  assert.equal(result.summary.overdueUnknownCount, 2);
  assert.equal(result.summary.overdueUnknownAmount, null);
  assert.equal(result.summary.noUnpaidCount, 1);
});

test('future payment snapshots are unknown while corrected earlier current due dates remain valid', () => {
  const future = ledger('f'); future.data.payment.asOf = '2026-11-11';
  const corrected = ledger('c'); corrected.data.payment.originalDueOn = '2026-12-01'; corrected.data.payment.currentDueOn = '2026-11-01';
  const result = overview([future, corrected]);
  assert.equal(result.ledgers[0].metrics.paymentKnown, false);
  assert.equal(result.ledgers[0].metrics.overdueDays, null);
  assert.equal(result.ledgers[1].metrics.overdueDays, 9);
  assert.equal(result.summary.overdueAmount, 80);
});

test('explicit zero is distinct from missing, negative, nonfinite and excessive precision amounts', () => {
  const values = [0, null, -1, Infinity, NaN, 0.001];
  const result = overview(values.map((value, index) => { const l = ledger(`l${index}`); l.data.finance.balance = value; l.data.payment.unpaidAmount = value; return l; }));
  assert.equal(result.summary.financeKnownCount, 1);
  assert.equal(result.summary.financeBalance, 0);
  assert.equal(result.summary.paymentKnownCount, 1);
  assert.equal(result.summary.paymentUnpaidAmount, 0);
  assert.ok(result.ledgers.slice(1).every((l) => l.metrics.financeBalance === null && l.metrics.paymentUnpaidAmount === null));
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('aggregate overflow produces null with a flag instead of unsafe integers or infinity', () => {
  const huge = ledger('h1'); huge.data.finance.balance = 60000000000000;
  const huge2 = ledger('h2'); huge2.data.finance.balance = 60000000000000;
  const result = overview([huge, huge2]);
  assert.equal(result.summary.financeKnownCount, 2);
  assert.equal(result.summary.financeBalance, null);
  assert.equal(result.summary.financeBalanceCents, null);
  assert.equal(result.summary.amountOverflow, true);
  assert.equal(result.buckets.aging.find((b) => b.key === '31-60').amountOverflow, true);
});

test('archived cases remain counted and voided ledgers remain visible without entering statistics', () => {
  const voided = ledger('void', { status: 'voided', voidReason: '重复登记' }, 'r2');
  const result = overview([ledger(), voided], [], [record('r1', { status: 'archived' }), record('r2')]);
  assert.equal(result.summary.financeBalance, 70);
  assert.equal(result.summary.archivedRecordCount, 1);
  assert.equal(result.summary.voidedLedgerCount, 1);
  assert.equal(result.ledgers.length, 2);
  assert.equal(result.ledgers[1].metrics.included, false);
  assert.equal(result.summary.recordsWithoutLedgerCount, 1);
});

test('aging and overdue bucket edges use their own explicit start dates', () => {
  const days = [0, 1, 30, 31, 60, 61, 90, 91, 180, 181, 365, 366];
  const before = (days) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  const list = days.map((days, i) => {
    const l = ledger(`l${i}`); l.data.finance.asOf = TODAY; l.data.finance.recognizedOn = '2020-01-01';
    l.data.finance.agingStartOn = before(days); l.data.payment.currentDueOn = before(days); return l;
  });
  const result = overview(list);
  assert.deepEqual(result.ledgers.map((l) => l.metrics.agingBucket), ['0-30', '0-30', '0-30', '31-60', '31-60', '61-90', '61-90', '91-180', '91-180', '181-365', '181-365', 'over365']);
  assert.equal(result.ledgers[0].metrics.overdueBucket, 'due_today');
  assert.equal(result.ledgers[1].metrics.overdueBucket, '1-30');
});

test('legal deadlines require manual basis, reviewer and nonfuture review date, never plus-three-years', () => {
  const good = event('good', { deadlineOn: '2026-11-09', deadlineBasis: '人工核对裁定第3页', deadlineReviewer: '法务甲', deadlineReviewedOn: '2026-11-01' });
  const noBasis = event('missing', { deadlineOn: '2026-01-01', deadlineReviewer: '法务乙', deadlineReviewedOn: '2026-01-01' });
  const futureReview = event('future', { deadlineOn: '2026-01-01', deadlineBasis: '录入依据', deadlineReviewer: '法务乙', deadlineReviewedOn: '2026-11-11' });
  const result = overview([ledger()], [good, noBasis, futureReview, event('plain')]);
  assert.equal(result.summary.deadlinesOverdueCount, 1);
  assert.equal(result.summary.deadlineUnknownCount, 2);
  assert.equal(result.legalEvents[0].metrics.deadlineLabel, '人工核定（填报）');
  assert.equal(result.legalEvents[1].metrics.deadlineState, 'unknown');
  assert.equal(result.timeline.filter((row) => row.source === 'legal_deadline').length, 3);
  assert.ok(!result.timeline.some((row) => row.date === '2029-11-01'));
});

test('corrections retain superseded events and their dates but only current reminders are counted', () => {
  const original = event('old', { reminderOn: '2026-11-01', deadlineOn: '2026-11-02', deadlineBasis: '原核对', deadlineReviewer: '甲', deadlineReviewedOn: '2026-11-01' });
  const correction = event('new', { reminderOn: TODAY, eventOn: '2026-11-03' }, { supersedesId: 'old' });
  const result = overview([ledger()], [original, correction]);
  assert.equal(result.summary.legalEventCount, 2);
  assert.equal(result.summary.supersededLegalEventCount, 1);
  assert.equal(result.summary.remindersOverdueCount, 0);
  assert.equal(result.summary.remindersDueCount, 1);
  assert.equal(result.summary.deadlinesOverdueCount, 0);
  const oldRows = result.timeline.filter((row) => row.eventId === 'old');
  assert.equal(oldRows.length, 3);
  assert.ok(oldRows.every((row) => row.superseded && row.supersededBy === 'new'));
});

test('timeline separates occurrence, delivery and system entry dates without assuming delivery effect', () => {
  const served = event('served', { eventOn: '2026-11-01', deliveryStatus: 'served', servedOn: '2026-11-03' }, { createdAt: '2026-11-09T02:00:00.000Z' });
  const pending = event('pending', { eventOn: '2026-11-02', deliveryStatus: 'pending', servedOn: '2026-11-04' });
  const invalid = event('invalid', { servedOn: '2026-02-30' });
  const future = event('future', { deliveryStatus: 'served', servedOn: '2026-11-11' });
  const result = overview([ledger()], [served, pending, invalid, future]);
  const rows = result.timeline.filter((row) => row.eventId === 'served');
  assert.deepEqual(rows.map((row) => [row.source, row.date]), [['legal_event', '2026-11-01'], ['legal_delivery', '2026-11-03']]);
  assert.ok(rows.every((row) => row.createdAt === '2026-11-09T02:00:00.000Z'));
  assert.equal(rows[1].title, '送达日期 · 书面催告');
  assert.equal(rows[1].verificationLabel, '送达日期（人工填报）');
  assert.equal(result.timeline.find((row) => row.source === 'legal_delivery' && row.eventId === 'pending').verificationLabel, '填报送达日期（状态待核）');
  assert.equal(result.timeline.find((row) => row.source === 'legal_delivery' && row.eventId === 'future').verificationLabel, '填报送达日期（状态待核）');
  assert.ok(!result.timeline.some((row) => row.source === 'legal_delivery' && row.eventId === 'invalid'));
  assert.equal(result.summary.deadlinesOverdueCount, 0);
});

test('defensive scoping removes orphan and cross-record links and prevents cross-record supersession', () => {
  const a = event('a');
  const cross = event('cross', { reminderOn: TODAY }, { recordId: 'r2', ledgerId: 'l1' });
  const other = event('other', {}, { recordId: 'r2', ledgerId: null, supersedesId: 'a' });
  const orphan = event('orphan', {}, { recordId: 'r3' });
  const result = overview([ledger(), ledger('orphan', {}, 'r3')], [a, cross, other, orphan], [record(), record('r2')]);
  assert.deepEqual(result.ledgers.map((l) => l.id), ['l1']);
  assert.deepEqual(result.legalEvents.map((e) => e.id), ['a', 'other']);
  assert.equal(result.legalEvents[0].metrics.superseded, false);
  assert.equal(result.summary.remindersDueCount, 0);
});

test('full timeline labels case input dates and Shanghai note entry dates without asserting legal effect', () => {
  const r = record('r1', { input: { contractDate: '2026-01-01', legalFactDate: '2026-02-01', arbitrationAgreementDate: '2026-03-01', dueDate: '2026-04-01' }, notes: [
    { id: 'n1', recordId: 'r1', body: '三个月前有过电话沟通', createdAt: '2026-11-09T16:30:00.000Z' },
    { id: 'bad', recordId: 'r2', body: '串案笔记', createdAt: '2026-11-09T01:00:00.000Z' },
  ] });
  const result = overview([ledger()], [event('unknown-date', { eventOn: '' })], [r]);
  const note = result.timeline.find((row) => row.source === 'note');
  assert.equal(note.date, TODAY);
  assert.equal(note.title, '录入跟进');
  assert.equal(note.verificationLabel, '录入日期（非事件发生日）');
  assert.equal(result.timeline.filter((row) => row.source === 'case_input').length, 4);
  assert.equal(result.timeline.find((row) => row.type === 'dueDate').deadlineOn, null);
  assert.equal(result.timeline.at(-1).date, null);
  assert.ok(!result.timeline.some((row) => row.description === '串案笔记'));
});

test('manual verification remains pending when review dates are impossible or unrecorded', () => {
  const good = event('good', { verification: 'reviewed', reviewer: '复核人', reviewedOn: '2026-11-02' });
  const early = event('early', { verification: 'reviewed', reviewer: '复核人', reviewedOn: '2026-10-31' });
  const future = event('future', { verification: 'reviewed', reviewer: '复核人', reviewedOn: '2026-11-11' });
  const missingEventDate = event('missing-date', { eventOn: '', verification: 'reviewed', reviewer: '复核人', reviewedOn: '2026-11-02' });
  const result = overview([ledger()], [good, early, future, missingEventDate]);
  assert.equal(result.legalEvents[0].metrics.verified, true);
  assert.equal(result.summary.pendingLegalEventCount, 3);
});

test('calculations use supplied calendar day and do not mutate or retain references to inputs', () => {
  const input = { records: [record()], ledgers: [ledger()], legalEvents: [event()] };
  const before = structuredClone(input);
  const result = buildOverview(input, '2026-11-11');
  assert.equal(result.ledgers[0].metrics.overdueDays, 6);
  assert.deepEqual(input, before);
  result.records[0].input.amount = 0;
  result.ledgers[0].data.finance.balance = 0;
  result.legalEvents[0].data.title = '编辑输出';
  assert.deepEqual(input, before);
  assert.throws(() => buildOverview(input, '2026-02-30'), TypeError);
  assert.throws(() => buildOverview(input, '2026-11-10T00:00:00Z'), TypeError);
});

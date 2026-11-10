/** Pure, owner-scoped overview calculations. No case amount or date creates a ledger. */
const DAY = 86400000;
const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const AGING = [['0-30', '0–30天'], ['31-60', '31–60天'], ['61-90', '61–90天'], ['91-180', '91–180天'], ['181-365', '181–365天'], ['over365', '365天以上'], ['unknown', '账龄待确认']];
const OVERDUE = [['not_due', '尚未到期'], ['due_today', '今日到期'], ['1-30', '逾期1–30天'], ['31-60', '逾期31–60天'], ['61-90', '逾期61–90天'], ['91-180', '逾期91–180天'], ['181-365', '逾期181–365天'], ['over365', '逾期365天以上'], ['unknown', '付款到期待确认']];

function clone(value) { return structuredClone(value); }
function present(value) { return typeof value === 'string' && value.trim().length > 0; }
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 2199) return null;
  const time = Date.UTC(year, month - 1, day);
  return new Date(time).toISOString().slice(0, 10) === value ? time / DAY : null;
}
function pastDate(value, today) { const result = date(value); return result !== null && result <= today ? result : null; }
function cents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  const result = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  return result <= MAX_CENTS ? Number(result) : null;
}
function safeCents(value) { return value <= MAX_CENTS && value >= -MAX_CENTS ? Number(value) : null; }
function amount(value) { return value === null ? null : value / 100; }
function bucketFor(days, first = '0-30') {
  if (days <= 30) return first;
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  if (days <= 180) return '91-180';
  if (days <= 365) return '181-365';
  return 'over365';
}
function state(on, today, superseded = false) {
  if (superseded) return 'superseded';
  const day = date(on);
  return day === null ? 'unknown' : day < today ? 'overdue' : day === today ? 'due_today' : 'upcoming';
}

function invoiceMetrics(data, today) {
  if (data.currency !== 'CNY') return { invoiceKnown: false, invoiceNetCents: null, invoiceNetAmount: null, invoiceReason: '币种待确认' };
  if (data.invoiceStatus === 'unconfirmed' || !['recorded', 'not_issued'].includes(data.invoiceStatus)) {
    return { invoiceKnown: false, invoiceNetCents: null, invoiceNetAmount: null, invoiceReason: '开票登记待确认' };
  }
  let sum = 0n;
  let validCount = 0;
  for (const invoice of Array.isArray(data.invoices) ? data.invoices : []) {
    if (invoice.status === 'voided') continue;
    const money = cents(invoice.amount);
    if (!['issued', 'red_offset'].includes(invoice.status) || money === null || pastDate(invoice.issuedOn, today) === null) {
      return { invoiceKnown: false, invoiceNetCents: null, invoiceNetAmount: null, invoiceReason: '发票金额或开票日期待核对' };
    }
    validCount++;
    sum += BigInt(money) * (invoice.status === 'red_offset' ? -1n : 1n);
  }
  if ((data.invoiceStatus === 'recorded' && !validCount) || (data.invoiceStatus === 'not_issued' && validCount > 0)) {
    return { invoiceKnown: false, invoiceNetCents: null, invoiceNetAmount: null, invoiceReason: '开票状态与明细待核对' };
  }
  const net = safeCents(sum);
  return { invoiceKnown: net !== null, invoiceNetCents: net, invoiceNetAmount: amount(net), invoiceReason: net === null ? '金额超过安全统计范围' : '' };
}

function financeMetrics(data, today) {
  const f = data.finance || {};
  const notRecognized = f.status === 'not_recognized';
  const balance = cents(f.balance);
  const recognized = pastDate(f.recognizedOn, today);
  const asOf = pastDate(f.asOf, today);
  let reason = '';
  if (data.currency !== 'CNY') reason = '币种待确认';
  else if (f.status !== 'confirmed') reason = f.status === 'not_recognized' ? '本节点未确认为财务应收' : '财务确认待补充';
  else if (balance === null) reason = '账面余额待核对';
  else if (recognized === null || asOf === null || recognized > asOf) reason = '确认日期或余额截至日期待核对';
  else if (!present(f.reference)) reason = '财务确认依据待补充';
  const known = !reason;
  const start = pastDate(f.agingStartOn, today);
  const agingKnown = known && start !== null && start <= asOf;
  const agingDays = agingKnown ? today - start : null;
  return {
    financeKnown: known, financeNotRecognized: notRecognized, financeBalanceCents: known ? balance : null, financeBalance: known ? amount(balance) : null, financeReason: reason,
    financeAsOf: date(f.asOf) === null ? null : f.asOf, financeSnapshotAgeDays: asOf === null ? null : today - asOf,
    financeFreshnessLabel: known ? `截至${f.asOf}的填报余额` : '余额截至日期或确认资料待核对',
    agingDays, agingBucket: notRecognized ? null : agingKnown ? bucketFor(agingDays) : 'unknown',
    agingReason: notRecognized ? '本节点未确认为财务应收，不计算账龄' : agingKnown ? '' : reason || '账龄起算日未明确或晚于余额截至日',
  };
}

function paymentMetrics(data, today) {
  const p = data.payment || {};
  const unpaid = cents(p.unpaidAmount);
  const asOf = pastDate(p.asOf, today);
  const originalDue = date(p.originalDueOn);
  const due = date(p.currentDueOn);
  let reason = '';
  if (data.currency !== 'CNY') reason = '币种待确认';
  else if (p.status !== 'confirmed') reason = p.status === 'conditional' ? '付款条件待满足或到期日待确认' : '付款到期情况待确认';
  else if (unpaid === null) reason = '节点未收金额待核对';
  else if (asOf === null) reason = '节点未收金额截至日期待核对';
  else if (originalDue === null || due === null || !present(p.basis)) reason = '原始到期日、当前到期日或到期依据待补充';
  const known = !reason;
  let maturity = 'unknown';
  let overdueDays = null;
  let overdueBucket = 'unknown';
  if (known) {
    if (unpaid === 0) { maturity = 'no_unpaid'; overdueBucket = null; }
    else {
      overdueDays = Math.max(0, today - due);
      maturity = due > today ? 'not_due' : due === today ? 'due_today' : 'overdue';
      overdueBucket = maturity === 'overdue' ? bucketFor(overdueDays, '1-30') : maturity;
    }
  }
  return { paymentKnown: known, paymentUnpaidCents: known ? unpaid : null, paymentUnpaidAmount: known ? amount(unpaid) : null, overdueDays, maturity, overdueBucket, paymentReason: reason,
    paymentAsOf: date(p.asOf) === null ? null : p.asOf, paymentSnapshotAgeDays: asOf === null ? null : today - asOf,
    paymentFreshnessLabel: known ? `截至${p.asOf}的节点未收金额` : '节点未收金额截至日期或到期资料待核对' };
}

function aggregate(values, unknownCount = 0) {
  const known = values.filter((value) => value !== null);
  const result = safeCents(known.reduce((sum, value) => sum + BigInt(value), 0n));
  const noKnown = known.length === 0 && unknownCount > 0;
  return { cents: noKnown ? null : result, amount: noKnown ? null : amount(result), overflow: result === null };
}
function bucketsFor(definitions, ledgers, key, money) {
  return definitions.map(([bucket, label]) => {
    const members = ledgers.filter((ledger) => ledger.metrics[key] === bucket);
    const values = members.map((ledger) => ledger.metrics[money]);
    const amountKnownCount = values.filter((value) => value !== null).length;
    const amountUnknownCount = members.length - amountKnownCount;
    const sum = aggregate(values, amountUnknownCount);
    return { key: bucket, label, count: members.length, amount: sum.amount, amountCents: sum.cents, amountKnownCount, amountUnknownCount, amountOverflow: sum.overflow };
  });
}

function eventMetrics(event, supersededBy, today) {
  const d = event.data || {};
  const superseded = Boolean(supersededBy);
  const reviewed = pastDate(d.reviewedOn, today);
  const eventOn = date(d.eventOn);
  const verified = d.verification === 'reviewed' && present(d.reviewer) && reviewed !== null && eventOn !== null && eventOn <= reviewed;
  const deadlineExpected = ['deadlineOn', 'deadlineBasis', 'deadlineReviewer', 'deadlineReviewedOn'].some((key) => present(d[key]));
  const deadlineVerified = date(d.deadlineOn) !== null && present(d.deadlineBasis) && present(d.deadlineReviewer) && pastDate(d.deadlineReviewedOn, today) !== null;
  return {
    superseded, supersededBy: supersededBy || null, verified, verificationLabel: verified ? '人工复核（填报）' : '待核实',
    reminderState: state(d.reminderOn, today, superseded), deadlineExpected, deadlineVerified,
    deadlineState: superseded ? 'superseded' : deadlineVerified ? state(d.deadlineOn, today) : 'unknown',
    deadlineLabel: deadlineVerified ? '人工核定（填报）' : '期限待核定',
  };
}

function eventTimeline(event, today) {
  const d = event.data || {};
  const m = event.metrics;
  const base = {
    recordId: event.recordId, ledgerId: event.ledgerId ?? null, eventId: event.id, type: d.type || 'other',
    title: d.title || '未命名法律事项', description: d.description || '', createdAt: event.createdAt || null,
    verificationLabel: m.verificationLabel, superseded: m.superseded, supersededBy: m.supersededBy,
    deliveryStatus: d.deliveryStatus || 'unknown', servedOn: d.servedOn || null, evidenceNote: d.evidenceNote || '', attachmentIds: clone(d.attachmentIds || []),
    reminderOn: d.reminderOn || null, reminderState: m.reminderState,
    deadlineOn: d.deadlineOn || null, deadlineState: m.deadlineState, deadlineVerified: m.deadlineVerified,
    deadlineLabel: m.deadlineLabel, deadlineBasis: d.deadlineBasis || '', deadlineReviewer: d.deadlineReviewer || '', deadlineReviewedOn: d.deadlineReviewedOn || null,
  };
  const result = [{ ...base, id: `event:${event.id}`, source: 'legal_event', date: date(d.eventOn) === null ? null : d.eventOn }];
  if (date(d.servedOn) !== null) result.push({
    ...base, id: `delivery:${event.id}`, source: 'legal_delivery', date: d.servedOn, title: `送达日期 · ${base.title}`,
    verificationLabel: d.deliveryStatus === 'served' && pastDate(d.servedOn, today) !== null ? '送达日期（人工填报）' : '填报送达日期（状态待核）',
  });
  if (present(d.reminderOn)) result.push({ ...base, id: `reminder:${event.id}`, source: 'legal_reminder', date: date(d.reminderOn) === null ? null : d.reminderOn, title: `人工提醒 · ${base.title}` });
  if (m.deadlineExpected) result.push({ ...base, id: `deadline:${event.id}`, source: 'legal_deadline', date: date(d.deadlineOn) === null ? null : d.deadlineOn, title: `人工期限 · ${base.title}` });
  return result;
}

function recordTimeline(record) {
  const result = [];
  const fields = [['contractDate', '合同日期'], ['legalFactDate', '法律事实日期'], ['arbitrationAgreementDate', '仲裁协议日期'], ['dueDate', '约定到期日']];
  for (const [field, title] of fields) {
    const value = record.input?.[field];
    if (!present(value)) continue;
    result.push({ id: `input:${record.id}:${field}`, recordId: record.id, ledgerId: null, eventId: null, source: 'case_input', type: field, date: date(value) === null ? null : value,
      title, description: field === 'dueDate' ? '案件填报的约定到期日；未用于付款到期或法律期限计算。' : '案件填报参考日期，尚未核实。',
      verificationLabel: '填报日期未核实', superseded: false, supersededBy: null, deadlineVerified: false, deadlineState: 'unknown', deadlineOn: null, reminderOn: null });
  }
  for (const note of Array.isArray(record.notes) ? record.notes : []) {
    if (note.recordId !== record.id) continue;
    const createdAt = typeof note.createdAt === 'string' ? note.createdAt : '';
    const noteDay = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(createdAt) && date(createdAt.slice(0, 10)) !== null && Number.isFinite(Date.parse(createdAt))
      ? new Date(Date.parse(createdAt) + 8 * 3600000).toISOString().slice(0, 10) : null;
    result.push({ id: `note:${note.id}`, recordId: record.id, ledgerId: null, eventId: null, source: 'note', type: 'follow_up', date: noteDay, createdAt,
      title: '录入跟进', description: note.body || '', verificationLabel: '录入日期（非事件发生日）', superseded: false, supersededBy: null, deadlineVerified: false, deadlineState: 'unknown', deadlineOn: null, reminderOn: null });
  }
  return result;
}

/** today is an explicit Asia/Shanghai YYYY-MM-DD supplied by the API, never the host timezone. */
export function buildOverview({ records = [], ledgers = [], legalEvents = [] } = {}, today) {
  const day = date(today);
  if (day === null) throw new TypeError('总览统计日期须为有效的 YYYY-MM-DD 日期。');
  const safeRecords = clone(records);
  const recordIds = new Set(safeRecords.map((record) => record.id));
  const enrichedLedgers = ledgers.filter((ledger) => recordIds.has(ledger.recordId)).map((ledger) => ({
    ...clone(ledger), metrics: { included: ledger.data?.status === 'active', ...invoiceMetrics(ledger.data || {}, day), ...financeMetrics(ledger.data || {}, day), ...paymentMetrics(ledger.data || {}, day) },
  }));
  const ledgerById = new Map(enrichedLedgers.map((ledger) => [ledger.id, ledger]));
  const scopedEvents = legalEvents.filter((event) => recordIds.has(event.recordId) && (!event.ledgerId || ledgerById.get(event.ledgerId)?.recordId === event.recordId));
  const eventById = new Map(scopedEvents.map((event) => [event.id, event]));
  const superseding = new Map();
  for (const event of scopedEvents) {
    const original = eventById.get(event.supersedesId);
    if (original && original.id !== event.id && original.recordId === event.recordId) superseding.set(original.id, event.id);
  }
  const enrichedEvents = scopedEvents.map((event) => ({ ...clone(event), metrics: eventMetrics(event, superseding.get(event.id), day) }));
  const active = enrichedLedgers.filter((ledger) => ledger.metrics.included);
  const currentEvents = enrichedEvents.filter((event) => !event.metrics.superseded);
  const financeKnown = active.filter((ledger) => ledger.metrics.financeKnown);
  const financeNotRecognized = active.filter((ledger) => ledger.metrics.financeNotRecognized);
  const financeUnknownCount = active.length - financeKnown.length - financeNotRecognized.length;
  const paymentKnown = active.filter((ledger) => ledger.metrics.paymentKnown);
  const agingKnown = active.filter((ledger) => ledger.metrics.agingDays !== null);
  const agingUnknown = active.filter((ledger) => ledger.metrics.agingBucket === 'unknown');
  const invoiceKnown = active.filter((ledger) => ledger.metrics.invoiceKnown);
  const maturity = (value) => active.filter((ledger) => ledger.metrics.maturity === value);
  const sums = [];
  const total = (members, key, unknown = 0) => { const result = aggregate(members.map((ledger) => ledger.metrics[key]), unknown); sums.push(result); return result; };
  const invoice = total(active, 'invoiceNetCents', active.length - invoiceKnown.length);
  const finance = total(active, 'financeBalanceCents', financeUnknownCount);
  const payment = total(active, 'paymentUnpaidCents', active.length - paymentKnown.length);
  const agingKnownTotal = total(agingKnown, 'financeBalanceCents');
  const agingUnknownTotal = total(agingUnknown, 'financeBalanceCents', agingUnknown.filter((ledger) => !ledger.metrics.financeKnown).length);
  const overdue = maturity('overdue');
  const dueToday = maturity('due_today');
  const notDue = maturity('not_due');
  const unknown = maturity('unknown');
  const overdueTotal = total(overdue, 'paymentUnpaidCents');
  const dueTodayTotal = total(dueToday, 'paymentUnpaidCents');
  const notDueTotal = total(notDue, 'paymentUnpaidCents');
  const unknownTotal = total(unknown, 'paymentUnpaidCents', unknown.length);
  const statusCounts = { invoice: { unconfirmed: 0, not_issued: 0, recorded: 0 }, finance: { unconfirmed: 0, confirmed: 0, not_recognized: 0 }, payment: { unconfirmed: 0, conditional: 0, confirmed: 0 } };
  for (const ledger of active) {
    const statuses = { invoice: ledger.data?.invoiceStatus, finance: ledger.data?.finance?.status, payment: ledger.data?.payment?.status };
    for (const [kind, status] of Object.entries(statuses)) if (Object.hasOwn(statusCounts[kind], status)) statusCounts[kind][status]++;
  }
  const summary = {
    recordCount: safeRecords.length, activeRecordCount: safeRecords.filter((record) => record.status === 'active').length, archivedRecordCount: safeRecords.filter((record) => record.status === 'archived').length,
    recordsWithoutLedgerCount: safeRecords.filter((record) => !active.some((ledger) => ledger.recordId === record.id)).length,
    ledgerCount: enrichedLedgers.length, activeLedgerCount: active.length, voidedLedgerCount: enrichedLedgers.filter((ledger) => ledger.data?.status === 'voided').length,
    invoiceNetAmount: invoice.amount, invoiceNetCents: invoice.cents, invoiceKnownCount: invoiceKnown.length, invoiceUnknownCount: active.length - invoiceKnown.length,
    financeBalance: finance.amount, financeBalanceCents: finance.cents, financeKnownCount: financeKnown.length, financeUnknownCount, financeNotRecognizedCount: financeNotRecognized.length,
    agingKnownCount: agingKnown.length, agingUnknownCount: agingUnknown.length, agingAmountKnownCount: agingUnknown.filter((ledger) => ledger.metrics.financeKnown).length + agingKnown.length,
    agingNotApplicableCount: financeNotRecognized.length, agingAmountUnknownCount: financeUnknownCount, agingKnownAmount: agingKnownTotal.amount, agingUnknownAmount: agingUnknownTotal.amount,
    paymentUnpaidAmount: payment.amount, paymentUnpaidCents: payment.cents, paymentKnownCount: paymentKnown.length, paymentUnknownCount: active.length - paymentKnown.length,
    maturityKnownCount: paymentKnown.length, overdueCount: overdue.length, overdueAmount: overdueTotal.amount,
    dueTodayCount: dueToday.length, dueTodayAmount: dueTodayTotal.amount, notDueCount: notDue.length, notDueAmount: notDueTotal.amount,
    noUnpaidCount: maturity('no_unpaid').length, overdueUnknownCount: unknown.length, overdueUnknownAmount: unknownTotal.amount,
    legalEventCount: enrichedEvents.length, pendingLegalEventCount: currentEvents.filter((event) => !event.metrics.verified).length,
    supersededLegalEventCount: enrichedEvents.length - currentEvents.length,
    remindersDueCount: currentEvents.filter((event) => event.metrics.reminderState === 'due_today').length,
    remindersOverdueCount: currentEvents.filter((event) => event.metrics.reminderState === 'overdue').length,
    deadlinesDueCount: currentEvents.filter((event) => event.metrics.deadlineState === 'due_today').length,
    deadlinesOverdueCount: currentEvents.filter((event) => event.metrics.deadlineState === 'overdue').length,
    deadlineUnknownCount: currentEvents.filter((event) => event.metrics.deadlineExpected && !event.metrics.deadlineVerified).length,
    statusCounts, amountOverflow: sums.some((sum) => sum.overflow),
  };
  const buckets = { aging: bucketsFor(AGING, active, 'agingBucket', 'financeBalanceCents'), overdue: bucketsFor(OVERDUE, active, 'overdueBucket', 'paymentUnpaidCents') };
  const timeline = [...enrichedEvents.flatMap((event) => eventTimeline(event, day)), ...safeRecords.flatMap(recordTimeline)].sort((a, b) => {
    if (a.date === null && b.date !== null) return 1;
    if (a.date !== null && b.date === null) return -1;
    return (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id);
  });
  return { today, records: safeRecords, ledgers: enrichedLedgers, legalEvents: enrichedEvents, timeline, summary, buckets };
}

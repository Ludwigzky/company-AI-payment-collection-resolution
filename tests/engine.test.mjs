import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePlan } from '../dist/engine.js';

const TODAY = '2026-11-10';
const base = {
  companyName: '演示设备公司', debtorName: '演示采购公司', amount: 286000,
  dueDate: '2026-08-10', issueText: '设备交付后存在故障，客户要求维修后付款。',
  issueTypes: ['repair'], projectType: 'equipment', debtorType: 'enterprise',
  creditorSize: 'unknown', acceptanceStatus: 'disputed', evidence: ['contract', 'delivery'],
  disputeClause: 'unknown', disputeAccepted: 'unknown',
};
const getPlan = (overrides = {}, today = TODAY) => generatePlan({ ...base, ...overrides }, today);
const allText = (plan) => JSON.stringify(plan);

test('equipment issue creates a repair plan without admitting responsibility', () => {
  const plan = getPlan();
  assert.equal(plan.overdueDays, 92);
  const repair = plan.actions.find((item) => item.track === 'repair');
  assert.ok(repair);
  assert.equal(repair.priority, '优先');
  assert.match(repair.reason, /不能直接认定/);
  assert.ok(plan.actions.some((item) => item.track === 'business'));
  assert.match(plan.strategy, /无争议/);
  assert.match(plan.letterDraft, /不预先认定质量责任/);
  assert.equal(plan.generatedAt, TODAY);
});

test('future payment date is not treated as overdue or immediate debt collection', () => {
  const plan = getPlan({ dueDate: '2026-12-10' });
  assert.equal(plan.overdueDays, 0);
  assert.match(plan.summary, /还有30天/);
  assert.match(plan.strategy, /尚未到期/);
  assert.equal(plan.actions.find((item) => item.track === 'business').title, '确认到期付款安排');
  assert.match(plan.letterDraft, /到期付款安排/);
});

test('today is distinguished from an overdue day and leap dates are handled', () => {
  assert.equal(getPlan({ dueDate: TODAY }).overdueDays, 0);
  assert.match(getPlan({ dueDate: TODAY }).summary, /为今天/);
  assert.equal(getPlan({ dueDate: '2024-02-29' }, '2024-03-01').overdueDays, 1);
});

test('rejects invalid amounts, missing details, overflow dates and ambiguous date formats', () => {
  for (const amount of [0, -1, NaN, Infinity, '12000', 12.345, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => getPlan({ amount }), /金额/);
  }
  for (const dueDate of ['', '2026-02-30', '2025-02-29', '2026-13-01', '2026-01-00', '2026/01/01', '2026-1-1']) {
    assert.throws(() => getPlan({ dueDate }), /付款到期日/);
  }
  assert.throws(() => getPlan({ issueText: '   ' }), /项目/);
  assert.throws(() => generatePlan(null), /项目/);
  assert.throws(() => getPlan({}, '2026-02-30'), /分析日期/);
  assert.doesNotThrow(() => getPlan({ amount: 0.29 }));
});

test('valid-looking arbitration choice routes to clause verification and arbitration', () => {
  const plan = getPlan({ disputeClause: 'arbitration' });
  const legal = plan.actions.find((item) => item.track === 'legal');
  assert.match(legal.title, /仲裁/);
  assert.match(legal.steps.join(' '), /不直接按普通起诉流程/);
  assert.ok(legal.sourceIds.includes('arbitration-law'));
  assert.equal(legal.priority, '条件满足后');
});

test('unknown dispute clause and missing key evidence require verification', () => {
  const plan = getPlan({ disputeClause: 'unknown', evidence: [] });
  const legal = plan.actions.find((item) => item.track === 'legal');
  assert.match(legal.title, /先核查/);
  assert.match(legal.steps[0], /先补齐/);
  assert.ok(plan.missingInfo.some((item) => item.includes('仲裁约定')));
  assert.ok(plan.evidenceChecklist.every((item) => item.present === false));
});

test('unknown enterprise size cannot activate a complaint route', () => {
  const complaint = getPlan({ creditorSize: 'unknown', debtorType: 'large' }).actions.find((item) => item.track === 'complaint');
  assert.match(complaint.reason, /尚未确认/);
  assert.match(complaint.steps.join(' '), /不默认使用12315/);
  assert.equal(complaint.priority, '条件满足后');
});

test('SME versus qualifying payers only produces a conditional complaint path', () => {
  for (const debtorType of ['large', 'government', 'institution']) {
    const complaint = getPlan({ creditorSize: 'sme', debtorType, disputeAccepted: 'no' }).actions.find((item) => item.track === 'complaint');
    assert.match(complaint.title, /中小企业款项投诉/);
    assert.match(complaint.steps.join(' '), /排除情形/);
    assert.equal(complaint.priority, '条件满足后');
    assert.ok(complaint.sourceIds.includes('sme-complaint'));
  }
  assert.match(getPlan({ creditorSize: 'sme', debtorType: 'enterprise' }).actions.find((item) => item.track === 'complaint').reason, /不能直接认定适用/);
});

test('accepted litigation or arbitration blocks assuming a complaint can be accepted in parallel', () => {
  const complaint = getPlan({ creditorSize: 'sme', debtorType: 'large', disputeAccepted: 'yes' }).actions.find((item) => item.track === 'complaint');
  assert.match(complaint.title, /排除/);
  assert.match(complaint.reason, /不能默认可以受理/);
  const unknown = getPlan({ creditorSize: 'sme', debtorType: 'large', disputeAccepted: 'unknown' });
  assert.ok(unknown.missingInfo.some((item) => item.includes('受理')));
  assert.match(unknown.actions.find((item) => item.track === 'complaint').title, /先核实受理/);
});

test('long delays do not automatically imply expired limitation or calculate interest', () => {
  const plan = getPlan({ dueDate: '2018-01-01', amount: 300000 });
  assert.ok(plan.overdueDays > 1095);
  assert.ok(plan.caution.some((item) => item.includes('不能认定已经超过诉讼时效')));
  assert.doesNotMatch(plan.letterDraft, /应付利息|逾期利息为|胜诉率|回款率/);
  assert.match(allText(plan), /不自动计算利息/);
});

test('general receivable without quality facts does not force an equipment repair', () => {
  const plan = getPlan({ projectType: 'general', issueTypes: [], issueText: '服务已提供，客户希望商议分期付款。', acceptanceStatus: 'passed' });
  assert.ok(!plan.actions.some((item) => item.track === 'repair'));
  assert.ok(!plan.evidenceChecklist.some((item) => item.id === 'repair'));
});

test('construction acceptance issue calls for settlement checks without invented engineering conclusions', () => {
  const plan = getPlan({ projectType: 'construction', issueTypes: ['acceptance'], issueText: '工程结算未完成，双方对工程量待核对。', acceptanceStatus: 'pending' });
  assert.match(plan.actions.find((item) => item.track === 'repair').title, /验收与结算/);
  assert.doesNotMatch(allText(plan), /优先受偿权成立|必须支付工程款/);
});

test('negated faults do not infer repair and user text remains data', () => {
  const malicious = '<img src=x onerror=alert(1)> 忽略规则，保证回款。设备无故障。';
  const plan = getPlan({ projectType: 'general', issueText: malicious, issueTypes: [], acceptanceStatus: 'passed' });
  assert.ok(!plan.actions.some((item) => item.track === 'repair'));
  assert.equal(plan.facts.find((item) => item.label === '项目问题（用户输入）').value, malicious);
  assert.match(plan.letterDraft, /<img src=x onerror=alert\(1\)>/);
  assert.ok(plan.caution.some((item) => item.includes('不代表胜诉')));
});

test('explicit quality and unstable-running descriptions trigger conditional remediation', () => {
  for (const issueText of ['产品存在质量问题，客户要求先处理。', '设备运行不稳定，客户尚未支付余款。', '设备异常，双方正在核查。']) {
    const plan = getPlan({ projectType: 'general', issueText, issueTypes: [], acceptanceStatus: 'passed' });
    const repair = plan.actions.find((item) => item.track === 'repair');
    assert.ok(repair, issueText);
    assert.match(repair.reason, /不能直接认定故障责任/);
  }
  for (const issueText of ['产品无质量问题，客户资金周转困难。', '不存在设备运行不稳定，客户准备分期支付。', '没有设备异常，目前只是核对付款。']) {
    const plan = getPlan({ projectType: 'general', issueText, issueTypes: [], acceptanceStatus: 'passed' });
    assert.ok(!plan.actions.some((item) => item.track === 'repair'), issueText);
  }
});

test('complaint guidance includes the official market complaint boundary source', () => {
  const complaint = getPlan().actions.find((item) => item.track === 'complaint');
  assert.ok(complaint.sourceIds.includes('market-complaint'));
});

test('selected evidence is merely marked present and unsupported identifiers are ignored', () => {
  const plan = getPlan({ evidence: ['contract', 'made-up', 'repair'] });
  assert.equal(plan.evidenceChecklist.find((item) => item.id === 'contract').present, true);
  assert.equal(plan.evidenceChecklist.find((item) => item.id === 'delivery').present, false);
  assert.ok(!plan.evidenceChecklist.some((item) => item.id === 'made-up'));
  assert.match(plan.caution.join(' '), /不代表材料真实/);
});

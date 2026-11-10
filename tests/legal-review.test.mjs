import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePlan } from '../dist/engine.js';
import { buildLegalReview } from '../src/legal-review.js';
import { LEGAL_CORPUS, CORPUS_VERSION, COVERAGE_NOTE } from '../src/legal-corpus.js';

const TODAY = '2026-11-10';
const BASE = {
  companyName: '甲公司', debtorName: '乙公司', amount: 128000, dueDate: '2026-08-01',
  issueText: '服务已提供，双方核对余额并协商付款。', projectType: 'general',
  debtorType: 'large', creditorSize: 'unknown', acceptanceStatus: 'unknown',
  disputeClause: 'unknown', disputeAccepted: 'unknown', issueTypes: [], evidence: [],
};
function review(overrides = {}, today = TODAY, materialSummary = []) {
  const input = { ...BASE, ...overrides };
  return buildLegalReview(input, generatePlan(input, today), { today, materialSummary });
}
function byId(result, id) { return result.findings.find((item) => item.id === id); }
function corpusCitation(id) { return LEGAL_CORPUS.find((clause) => clause.id === id); }

test('legal review links every proposition to unverified facts, exact originals and complete version metadata', () => {
  const result = review();
  assert.equal(result.schemaVersion, '1.0');
  assert.equal(result.reviewedAt, TODAY);
  assert.equal(result.jurisdiction, '中国大陆');
  assert.equal(result.corpusVersion, CORPUS_VERSION);
  assert.equal(result.coverageNote, COVERAGE_NOTE);
  const facts = new Set(result.facts.map(({ id }) => id));
  for (const item of result.findings) {
    assert.ok(item.factIds.length > 0);
    assert.ok(item.factIds.every((id) => facts.has(id)));
    assert.ok(item.whyApplicable.length > 0);
    assert.ok(item.missingEvidence.length > 0);
    assert.ok(item.conditions.length > 0);
    assert.ok(item.citations.length > 0);
    assert.ok(['conditional', 'insufficient', 'not_applicable'].includes(item.status));
    for (const citation of item.citations) {
      const original = corpusCitation(citation.id);
      for (const [key, value] of Object.entries(original)) assert.deepEqual(citation[key], value);
      for (const field of ['lawTitle', 'article', 'text', 'versionId', 'versionLabel', 'effectiveFrom', 'issuer', 'officialUrl', 'locator', 'verifiedAt', 'temporalStatus', 'temporalNote']) {
        assert.equal(typeof citation[field], 'string', `${citation.id}.${field}`);
        assert.ok(citation[field].length > 0, `${citation.id}.${field}`);
      }
    }
  }
  assert.ok(result.facts.every((fact) => fact.verification === 'unverified'));
});

test('the retrieved corpus is selective, ranked and traceable with complete text under a hard budget', () => {
  const result = review({ creditorSize: 'large', debtorType: 'enterprise' });
  const selected = result.retrieval.retrievedClauseIds;
  assert.ok(selected.length < LEGAL_CORPUS.length);
  assert.equal(new Set(selected).size, selected.length);
  assert.ok(!selected.includes('civil-525'));
  assert.ok(!selected.includes('civil-615'));
  assert.ok(!selected.includes('civil-621'));
  assert.ok(!selected.includes('sme-complaint-6'));
  assert.match(result.retrieval.method, /topic-and-lexical/);
  assert.equal(result.retrieval.budget.maxClauses, 16);
  assert.equal(result.retrieval.budget.maxCharacters, 12000);
  assert.ok(result.retrieval.budget.selectedClauses <= 16);
  assert.ok(result.retrieval.budget.selectedCharacters <= 12000);
  assert.equal(result.retrieval.budget.selectedCharacters, selected.reduce((sum, id) => sum + corpusCitation(id).text.length, 0));
  assert.equal(result.retrieval.budget.textTruncated, false);
  for (const query of result.retrieval.queries) {
    assert.ok(query.question);
    assert.ok(query.candidateCount > 0);
    assert.ok(query.hits.every((hit) => Number.isFinite(hit.score) && Array.isArray(hit.topicMatches) && Array.isArray(hit.lexicalMatches)));
    for (const id of query.clauseIds) {
      assert.ok(selected.includes(id));
      const hit = query.hits.find((entry) => entry.clauseId === id);
      assert.equal(hit.selected, true);
      assert.ok(hit.score > 0);
      assert.match(hit.selection, /required-condition-expansion|ranked-context/);
    }
  }
});

test('the largest issue combination fits all mandatory legal conditions without a whole-corpus dump', () => {
  const result = review({
    projectType: 'equipment', issueText: '设备存在故障与验收异议。', issueTypes: ['repair'],
    disputeClause: 'arbitration', creditorSize: 'sme', debtorType: 'large', disputeAccepted: 'no',
  });
  assert.equal(result.retrieval.retrievedClauseIds.length, 16);
  assert.equal(result.retrieval.budget.incompleteRequiredConditions, false);
  assert.ok(result.retrieval.queries.every((query) => query.missingRequiredClauseIds.length === 0));
  for (const id of ['arbitration-29', 'sme-24', 'sme-25', 'sme-complaint-6', 'sme-complaint-7']) assert.ok(result.retrieval.retrievedClauseIds.includes(id));
  for (const finding of result.findings) for (const citation of finding.citations) assert.equal(citation.text, corpusCitation(citation.id).text);
});

test('a reduced context budget names missing mandatory conditions and never silently shortens a clause', () => {
  const input = { ...BASE, disputeClause: 'arbitration', creditorSize: 'sme', disputeAccepted: 'no' };
  const result = buildLegalReview(input, generatePlan(input, TODAY), { today: TODAY, retrievalBudget: { maxClauses: 2, maxCharacters: 12000 } });
  assert.equal(result.retrieval.retrievedClauseIds.length, 2);
  assert.equal(result.retrieval.budget.incompleteRequiredConditions, true);
  const mapping = { payment: 'payment-claim', performance: 'performance-defense', procedure: 'dispute-procedure', limitation: 'limitation-review', complaint: 'sme-complaint' };
  for (const query of result.retrieval.queries.filter((query) => query.missingRequiredClauseIds.length)) {
    const finding = byId(result, mapping[query.id]);
    // No time-bar advice is emitted when not even one limitation clause fits.
    if (query.id === 'limitation' && !finding) continue;
    assert.equal(finding.status, 'insufficient');
    for (const id of query.missingRequiredClauseIds) assert.ok(finding.missingEvidence.some((gap) => gap.includes(id)));
  }
  for (const finding of result.findings) for (const citation of finding.citations) assert.equal(citation.text, corpusCitation(citation.id).text);
  const tiny = buildLegalReview(input, generatePlan(input, TODAY), { today: TODAY, retrievalBudget: { maxCharacters: 1 } });
  assert.equal(tiny.retrieval.budget.selectedCharacters, 0);
  assert.ok(tiny.findings.every(({ status }) => status === 'insufficient'));
  assert.ok(!byId(tiny, 'limitation-review'));
});

test('even all evidence marked present does not prove authenticity, payment conditions, balance or actual dates', () => {
  const result = review({
    evidence: ['contract', 'delivery', 'acceptance', 'invoice', 'reconciliation', 'collection', 'repair'],
    acceptanceStatus: 'passed', disputeClause: 'court', creditorSize: 'sme', disputeAccepted: 'no',
  });
  const payment = byId(result, 'payment-claim');
  assert.equal(payment.status, 'insufficient');
  assert.match(payment.missingEvidence.join(' '), /原件.*真实性/);
  assert.match(payment.missingEvidence.join(' '), /付款前提是否成就/);
  assert.match(payment.missingEvidence.join(' '), /银行流水复核余额/);
  assert.match(payment.missingEvidence.join(' '), /实际日期/);
  for (const fact of result.facts.filter(({ field }) => field === 'evidence')) {
    assert.match(fact.value, /填报持有.*未核验/);
    assert.equal(fact.verification, 'unverified');
  }
  assert.ok(result.findings.every((finding) => finding.status === 'insufficient'));
});

test('material inventory remains an unverified inventory and cannot fill contractual facts', () => {
  const materials = [{ id: 'a1', name: '付款确认.pdf', marker: '[材料1:付款确认.pdf]', method: 'PDF文字提取', limitations: ['签章未核验'] }];
  const result = review({}, TODAY, materials);
  const materialFact = result.facts.find((fact) => fact.source === 'material_inventory');
  assert.equal(materialFact.verification, 'unverified');
  assert.equal(materialFact.value.id, 'a1');
  assert.match(materialFact.note, /没有.*已证实/);
  assert.equal(byId(result, 'payment-claim').status, 'insufficient');
  assert.match(byId(result, 'payment-claim').missingEvidence.join(' '), /真实性/);
  materials[0].name = '后来修改的文件名.pdf';
  materials[0].limitations.push('后来修改');
  assert.equal(materialFact.value.name, '付款确认.pdf');
  assert.deepEqual(materialFact.value.limitations, ['签章未核验']);
});

test('future due date cannot support a matured-payment claim', () => {
  const payment = byId(review({ dueDate: '2026-12-01' }), 'payment-claim');
  assert.equal(payment.status, 'insufficient');
  assert.match(payment.advice, /尚未来临.*不能据此认定/);
  assert.match(payment.missingEvidence.join(' '), /提前到期事由/);
});

test('unknown dispute clause blocks choosing a court or arbitration route', () => {
  const procedure = byId(review({ disputeClause: 'unknown' }), 'dispute-procedure');
  assert.equal(procedure.status, 'insufficient');
  assert.match(procedure.advice, /不能选定诉讼或仲裁/);
  assert.ok(procedure.citations.some(({ id }) => id === 'civil-procedure-122'));
  assert.ok(procedure.citations.some(({ id }) => id === 'arbitration-5'));
  assert.match(procedure.missingEvidence.join(' '), /争议解决约定尚未明确/);
});

test('court option still requires jurisdiction, claim facts and exclusion of a valid arbitration agreement', () => {
  const procedure = byId(review({ disputeClause: 'court' }), 'dispute-procedure');
  assert.equal(procedure.status, 'insufficient');
  assert.match(procedure.conditions.join(' '), /主体.*被告.*管辖/);
  assert.match(procedure.conditions.join(' '), /仲裁协议/);
  assert.equal(procedure.citations.find(({ id }) => id === 'civil-procedure-122').temporalStatus, 'provisional_current_procedure');
  assert.match(procedure.citations[0].temporalNote, /实际.*日期/);
});

test('arbitration agreement validity never inherits a 2026 statute version from a payment due date', () => {
  for (const dueDate of ['2018-01-01', '2026-08-01', '2027-08-01']) {
    const procedure = byId(review({ dueDate, disputeClause: 'arbitration', creditorSize: 'large' }), 'dispute-procedure');
    assert.equal(procedure.status, 'insufficient');
    for (const id of ['arbitration-4', 'arbitration-27', 'arbitration-28', 'arbitration-29']) {
      const citation = procedure.citations.find((item) => item.id === id);
      assert.ok(citation, id);
      assert.equal(citation.temporalStatus, 'historical_scope_unconfirmed');
      assert.match(citation.temporalNote, /到期日不能决定/);
    }
    assert.match(procedure.missingEvidence.join(' '), /仲裁协议订立日期.*旧协议/);
  }
});

test('a review before the new arbitration statute takes effect marks it unusable for present certainty', () => {
  const result = review({ disputeClause: 'arbitration', dueDate: '2025-10-01' }, '2026-02-01');
  const procedure = byId(result, 'dispute-procedure');
  assert.equal(procedure.status, 'insufficient');
  assert.ok(procedure.citations.every((citation) => citation.temporalStatus === 'not_yet_effective_at_review'));
  assert.match(procedure.missingEvidence.join(' '), /历史版本.*官方现行文本/);
});

test('historical facts outside covered versions require historical law retrieval without inferring occurrence dates', () => {
  const result = review({ dueDate: '2018-01-01' });
  assert.equal(byId(result, 'payment-claim').status, 'insufficient');
  assert.ok(result.limitations.some((item) => /早于.*施行日.*不等于认定.*法律事实发生日/.test(item)));
  assert.match(byId(result, 'payment-claim').missingEvidence.join(' '), /到期日不能替代/);
  const early = review({ dueDate: '2018-01-01' }, '2020-11-10');
  assert.ok(byId(early, 'payment-claim').citations.every((citation) => citation.temporalStatus === 'not_yet_effective_at_review'));
});

const DATE_READY = {
  contractDate: '2026-04-01', legalFactDate: '2026-08-01', arbitrationAgreementDate: '2026-04-01',
  acceptanceStatus: 'passed', creditorSize: 'sme', debtorType: 'large', disputeClause: 'court', disputeAccepted: 'no',
  evidence: ['contract', 'delivery', 'acceptance', 'invoice', 'reconciliation', 'collection', 'repair'],
};

test('explicit in-period dates and reported core evidence allow only a conditional checklist assessment', () => {
  const result = review(DATE_READY);
  for (const id of ['payment-claim', 'dispute-procedure', 'limitation-review', 'sme-complaint']) {
    const finding = byId(result, id);
    assert.equal(finding.status, 'conditional', id);
    assert.ok(finding.missingEvidence.length > 0);
    assert.match(finding.missingEvidence.join(' '), /真实性/);
    assert.ok(finding.citations.every((citation) => ['reported_dates_within_version', 'provisional_current_procedure'].includes(citation.temporalStatus)));
  }
  assert.ok(result.facts.every(({ verification }) => verification === 'unverified'));
  assert.equal(result.facts.find(({ field }) => field === 'contractDate').value, DATE_READY.contractDate);
  assert.equal(result.facts.find(({ field }) => field === 'legalFactDate').value, DATE_READY.legalFactDate);
  assert.ok(result.limitations.some((limitation) => /仅为未经核验的时间线索/.test(limitation)));
  assert.ok(!result.limitations.some((limitation) => /当前输入没有.*日期/.test(limitation)));
});

test('a known date before the loaded substantive version requires historical law even with every evidence checkbox', () => {
  const result = review({ ...DATE_READY, contractDate: '2020-04-01', legalFactDate: '2020-08-01' });
  const payment = byId(result, 'payment-claim');
  assert.equal(payment.status, 'insufficient');
  assert.ok(payment.citations.every(({ temporalStatus }) => temporalStatus === 'historical_version_required'));
  assert.match(payment.missingEvidence.join(' '), /历史版本及衔接规则/);
  const smeOld = byId(review({ ...DATE_READY, contractDate: '2024-04-01', legalFactDate: '2024-08-01' }), 'sme-complaint');
  assert.equal(smeOld.status, 'insufficient');
  assert.equal(smeOld.citations.find(({ id }) => id === 'sme-3').temporalStatus, 'historical_version_required');
});

test('new arbitration agreement dates are distinct from contract and payment dates and remain unverified', () => {
  const within = byId(review({ ...DATE_READY, disputeClause: 'arbitration' }), 'dispute-procedure');
  assert.equal(within.status, 'conditional');
  assert.ok(within.citations.filter(({ id }) => ['arbitration-4', 'arbitration-27', 'arbitration-28', 'arbitration-29'].includes(id))
    .every(({ temporalStatus }) => temporalStatus === 'reported_dates_within_version'));
  const old = byId(review({ ...DATE_READY, disputeClause: 'arbitration', arbitrationAgreementDate: '2025-09-01' }), 'dispute-procedure');
  assert.equal(old.status, 'insufficient');
  assert.ok(old.citations.filter(({ id }) => id !== 'arbitration-5').every(({ temporalStatus }) => temporalStatus === 'historical_version_required'));
  const missing = byId(review({ ...DATE_READY, disputeClause: 'arbitration', arbitrationAgreementDate: undefined }), 'dispute-procedure');
  assert.equal(missing.status, 'insufficient');
  assert.match(missing.missingEvidence.join(' '), /补充或更正填报仲裁协议订立日期/);
});

test('future or invalid legal fact dates cannot become completed facts or conditional legal conclusions', () => {
  for (const legalFactDate of ['2026-12-01', '2026-02-30']) {
    const input = { ...BASE, ...DATE_READY, legalFactDate };
    const payment = byId(buildLegalReview(input, { generatedAt: TODAY }), 'payment-claim');
    assert.equal(payment.status, 'insufficient');
    assert.ok(payment.citations.every(({ temporalStatus }) => temporalStatus === (legalFactDate === '2026-12-01' ? 'reported_date_in_future' : 'reported_date_invalid')));
    assert.match(payment.missingEvidence.join(' '), /更正|晚于分析日/);
  }
  const futureAgreement = byId(review({ ...DATE_READY, disputeClause: 'arbitration', arbitrationAgreementDate: '2026-12-01' }), 'dispute-procedure');
  assert.equal(futureAgreement.status, 'insufficient');
  assert.ok(futureAgreement.citations.filter(({ id }) => id !== 'arbitration-5').every(({ temporalStatus }) => temporalStatus === 'reported_date_in_future'));
});

test('explicit dates do not waive unknown dispute clauses, unknown payer size, evidence gaps or future maturity', () => {
  assert.equal(byId(review({ ...DATE_READY, disputeClause: 'unknown' }), 'dispute-procedure').status, 'insufficient');
  assert.equal(byId(review({ ...DATE_READY, debtorType: 'enterprise' }), 'sme-complaint').status, 'insufficient');
  assert.equal(byId(review({ ...DATE_READY, evidence: ['contract'] }), 'payment-claim').status, 'insufficient');
  assert.equal(byId(review({ ...DATE_READY, dueDate: '2026-12-01' }), 'payment-claim').status, 'insufficient');
  assert.equal(byId(review({ ...DATE_READY, dueDate: '2026-12-01' }), 'sme-complaint').status, 'insufficient');
  const invalidOrder = byId(review({ ...DATE_READY, contractDate: '2026-09-01', legalFactDate: '2026-08-01' }), 'payment-claim');
  assert.equal(invalidOrder.status, 'insufficient');
  assert.match(invalidOrder.missingEvidence.join(' '), /早于合同订立日期/);
});

test('unknown identity or acceptance status never activates SME complaint eligibility', () => {
  for (const overrides of [
    { creditorSize: 'unknown', debtorType: 'large', disputeAccepted: 'no' },
    { creditorSize: 'sme', debtorType: undefined, disputeAccepted: 'no' },
    { creditorSize: 'sme', debtorType: 'large', disputeAccepted: 'unknown' },
  ]) {
    const complaint = byId(review(overrides), 'sme-complaint');
    assert.equal(complaint.status, 'insufficient');
    assert.match(complaint.missingEvidence.join(' '), /订立合同时.*划型/);
    assert.match(complaint.missingEvidence.join(' '), /受理或者处理/);
  }
});

test('non-SME creditors and already accepted matters have an explicit inapplicable complaint status', () => {
  for (const overrides of [
    { creditorSize: 'large', debtorType: 'large', disputeAccepted: 'no' },
    { creditorSize: 'sme', debtorType: 'government', disputeAccepted: 'yes' },
  ]) assert.equal(byId(review(overrides), 'sme-complaint').status, 'not_applicable');
  const accepted = byId(review({ creditorSize: 'sme', debtorType: 'government', disputeAccepted: 'yes' }), 'sme-complaint');
  assert.match(accepted.advice, /不能建议直接提交同一事项/);
  assert.ok(accepted.citations.some(({ id }) => id === 'sme-complaint-7'));
  assert.equal(byId(review({ creditorSize: 'sme', debtorType: 'enterprise', disputeAccepted: 'no' }), 'sme-complaint').status, 'insufficient');
});

test('a reported qualifying SME complaint still exposes all material, identity, historical and procedural gates', () => {
  const complaint = byId(review({ creditorSize: 'sme', debtorType: 'government', disputeAccepted: 'no' }), 'sme-complaint');
  assert.equal(complaint.status, 'insufficient');
  assert.deepEqual(new Set(complaint.citations.map(({ id }) => id)), new Set(['sme-2', 'sme-3', 'sme-24', 'sme-25', 'sme-complaint-6', 'sme-complaint-7']));
  assert.match(complaint.conditions.join(' '), /订立合同时/);
  assert.match(complaint.conditions.join(' '), /签署或盖章/);
  assert.match(complaint.conditions.join(' '), /法院.*仲裁.*行政.*社会调解/);
  assert.match(complaint.cautions.join(' '), /不因.*尚无受理记录.*全部排除/);
});

test('generic business coordination has no invented equipment repair or quality legal finding', () => {
  for (const issueText of ['客户资金周转困难，要求商议分期付款。', '产品无质量问题，只需核对余额。', '不存在设备运行不稳定，客户准备分期支付。']) {
    const result = review({ projectType: 'general', acceptanceStatus: 'passed', issueText });
    assert.ok(!byId(result, 'performance-defense'), issueText);
    assert.ok(!result.retrieval.queries.some(({ id }) => id === 'performance'), issueText);
    assert.deepEqual(result.businessActionIds, ['business-action']);
    assert.ok(result.findings.every(({ actionId }) => !['business-action', 'repair-action'].includes(actionId)));
  }
});

test('real quality or acceptance issues retrieve both reciprocal-performance alternatives without assigning fault', () => {
  for (const overrides of [
    { issueText: '服务质量存在争议。', issueTypes: ['repair'] },
    { issueText: '设备运行不稳定。' },
    { issueText: '设备无法运行，客户拒付货款。' },
    { issueText: '设备无法启动，客户拒付货款。' },
    { issueText: '设备宕机，客户拒付货款。' },
    { acceptanceStatus: 'pending' },
  ]) {
    const performance = byId(review(overrides), 'performance-defense');
    assert.ok(performance);
    assert.equal(performance.status, 'insufficient');
    assert.ok(performance.citations.some(({ id }) => id === 'civil-525'));
    assert.ok(performance.citations.some(({ id }) => id === 'civil-526'));
    assert.match(performance.conditions.join(' '), /先后履行顺序/);
    assert.match(performance.cautions.join(' '), /没有预先认定质量责任/);
  }
});

test('limitation review cites both the starting rule and interruptions and never declares an expiry date', () => {
  const limitation = byId(review({ dueDate: '2018-01-01' }), 'limitation-review');
  assert.equal(limitation.status, 'insufficient');
  assert.deepEqual(new Set(limitation.citations.map(({ id }) => id)), new Set(['civil-188', 'civil-195']));
  assert.match(limitation.whyApplicable, /不足以确定/);
  assert.match(limitation.missingEvidence.join(' '), /送达时间/);
  assert.match(limitation.cautions.join(' '), /没有计算届满日期/);
});

test('reviews detach and freeze all facts, citations and traces without shared case state', () => {
  const firstInput = { ...BASE, companyName: '只属于案件甲', evidence: ['contract'], issueTypes: [] };
  const first = buildLegalReview(firstInput, generatePlan(firstInput, TODAY));
  firstInput.evidence.push('delivery');
  firstInput.companyName = '已修改';
  const second = review({ companyName: '只属于案件乙' });
  assert.equal(first.facts.find(({ field }) => field === 'companyName').value, '只属于案件甲');
  assert.ok(!JSON.stringify(second).includes('只属于案件甲'));
  assert.match(first.facts.find(({ id }) => id === 'fact-evidence-delivery').value, /未勾选/);
  assert.throws(() => { first.findings[0].citations[0].text = '篡改原文'; }, TypeError);
  assert.throws(() => { first.retrieval.queries[0].hits.push({}); }, TypeError);
  assert.throws(() => { first.facts[0].value = '篡改事实'; }, TypeError);
  assert.throws(() => { first.limitations.push('篡改'); }, TypeError);
  assert.equal(second.findings[0].citations[0].text, corpusCitation(second.findings[0].citations[0].id).text);
  assert.notEqual(first.findings[0].citations[0], second.findings[0].citations[0]);
});

test('analysis date must be explicit from options or plan and cannot be an overflowing calendar date', () => {
  assert.throws(() => buildLegalReview(BASE), /分析日期/);
  assert.throws(() => buildLegalReview(BASE, {}, { today: '2026-02-30' }), /分析日期/);
  assert.throws(() => buildLegalReview(null, {}, { today: TODAY }), /案件/);
});

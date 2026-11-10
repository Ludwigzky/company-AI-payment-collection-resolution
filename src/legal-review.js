import { LEGAL_CORPUS, CORPUS_VERSION, COVERAGE_NOTE } from './legal-corpus.js';

const MAX_CLAUSES = 16;
const MAX_CHARACTERS = 12000;
const STATUS_LABELS = Object.freeze({
  conditional: '仅供有条件核查', insufficient: '依据不足，待补充核验', not_applicable: '按当前填报不适用',
});
const LABELS = Object.freeze({
  companyName: '债权人名称', debtorName: '付款方名称', amount: '填报待核对金额（元）',
  dueDate: '填报付款到期日', issueText: '项目情况原始陈述', projectType: '业务类型（用户选择）',
  debtorType: '付款方类型（用户选择）', creditorSize: '债权人企业规模（用户选择）',
  acceptanceStatus: '验收或结算状态（用户选择）', disputeClause: '争议解决约定（用户选择）',
  disputeAccepted: '同一事项既有受理或处理状态（用户选择）', issueTypes: '问题类型（用户选择）',
  contractDate: '填报合同订立日期', legalFactDate: '填报相关法律事实发生日期',
  arbitrationAgreementDate: '填报仲裁协议订立日期',
});
const EVIDENCE_LABELS = Object.freeze({
  contract: '合同及补充协议', delivery: '交付或服务履行记录', acceptance: '验收与结算资料',
  invoice: '发票及开票沟通', reconciliation: '对账单及付款流水', collection: '催收及送达记录', repair: '故障与整改记录',
});
const TIME_GAP = '核验已填报或待补充的合同订立、履约、争议发生及权利主张的实际日期与完整时间线；填报到期日不能替代法律事实发生日期，单一日期也不能替代完整时间线。';
const AUTHENTICITY_GAP = '核验各份材料的原件、形成过程、签署权限、真实性、完整性及相互对应关系；勾选持有或上传文件均不代表已经证明。';

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : null;
}

function reviewDate(today, basePlan) {
  const result = dateOnly(today ?? basePlan?.generatedAt);
  if (!result) throw new TypeError('法律核查需要有效的分析日期。');
  return result;
}

function factManifest(input, materials) {
  const facts = Object.entries(LABELS).map(([field, label]) => ({
    id: `fact-${field}`, label, value: clone(input[field] ?? (field === 'issueTypes' ? [] : 'unknown')),
    source: 'user_reported', verification: 'unverified', field,
  }));
  const present = new Set(Array.isArray(input.evidence) ? input.evidence : []);
  for (const [key, label] of Object.entries(EVIDENCE_LABELS)) {
    facts.push({
      id: `fact-evidence-${key}`, label: `${label}持有情况`,
      value: present.has(key) ? '用户填报持有，内容及效力未核验' : '本次未勾选持有，不能据此认定材料不存在',
      source: 'user_reported', verification: 'unverified', field: 'evidence', evidenceId: key,
    });
  }
  for (const [index, item] of materials.entries()) {
    facts.push({
      id: `fact-material-${index + 1}`, label: '本次选中材料清单',
      value: { id: item.id, name: item.name, marker: item.marker, method: item.method, limitations: clone(item.limitations ?? []) },
      source: 'material_inventory', verification: 'unverified',
      note: '这里只确认本次材料清单；没有将提取文字或模型识别结果转为已证实的案件事实。',
    });
  }
  return facts;
}

function hasPerformanceIssue(input) {
  if (input.issueTypes?.some((type) => ['repair', 'acceptance'].includes(type))) return true;
  if (['pending', 'disputed'].includes(input.acceptanceStatus)) return true;
  const description = String(input.issueText ?? '')
    .replace(/(?:没有|不存在|无|无需|不需要)(?:任何)?(?:设备)?(?:故障|维修|质量问题|质量异议|质量争议|验收争议|发票问题|运行不稳定|运转不稳定|异常)/g, '')
    .replace(/(?:已|已经)(?:完成)?(?:维修|验收|开票)/g, '');
  return /故障|维修|检修|停机|宕机|返修|设备损坏|质量问题|质量异议|质量争议|运行不稳定|运转不稳定|设备异常|无法启动|无法运行|未验收|待验收|拒绝验收|验收未通过|验收争议|结算未完成|尚未结算/.test(description);
}

function complaintProfile(input) {
  if (input.disputeAccepted === 'yes') return 'accepted';
  if (input.creditorSize === 'large') return 'excluded_identity';
  if (input.creditorSize !== 'sme' || !['large', 'government', 'institution'].includes(input.debtorType)) return 'unknown_identity';
  return input.disputeAccepted === 'no' ? 'eligible_reported' : 'unknown_acceptance';
}

function queryDefinitions(input, performance, profile) {
  const queries = [{
    id: 'payment', question: '填报的合同待付款项，在付款条件、实际履行和余额核验后，可能有哪些金钱债务请求依据？',
    topics: ['payment', 'contract-performance'], terms: ['支付价款', '报酬', '金钱债务', '履行义务'],
    requiredIds: ['civil-579'], optionalIds: ['civil-509'],
  }];
  if (performance) queries.push({
    id: 'performance', question: '存在填报的履约或验收异议时，须分别核查哪些同时履行或先履行抗辩条件？',
    topics: ['reciprocal-defense', 'quality', 'contract-performance'], terms: ['同时履行', '先履行', '履行抗辩', '履行债务不符合约定'],
    requiredIds: ['civil-525', 'civil-526'], optionalIds: ['civil-582'],
  });
  queries.push(input.disputeClause === 'arbitration' ? {
    id: 'procedure', question: '用户填报存在仲裁约定，须核查协议原文、订立日期、必要内容和无效情形；不能将新法自动用于旧协议。',
    topics: ['arbitration'], terms: ['仲裁协议', '请求仲裁的意思表示', '仲裁事项', '无效'],
    requiredIds: ['arbitration-4', 'arbitration-27', 'arbitration-28', 'arbitration-29'], optionalIds: ['arbitration-5'],
  } : {
    id: 'procedure', question: '选择民事起诉前，怎样核查起诉条件、管辖和可能存在的仲裁协议排除条件？',
    topics: ['court', 'arbitration'], terms: ['起诉必须符合', '明确的被告', '诉讼请求', '人民法院不予受理', '仲裁协议'],
    requiredIds: ['civil-procedure-122', 'arbitration-5'], optionalIds: ['arbitration-4'],
  });
  queries.push({
    id: 'limitation', question: '请求权时效需要哪些起算、中断和送达事实，为什么不能只按填报到期日或逾期天数判断？',
    topics: ['limitation'], terms: ['诉讼时效', '知道或者应当知道', '中断', '履行请求'],
    requiredIds: ['civil-188', 'civil-195'], optionalIds: [],
  });
  queries.push({
    id: 'complaint', question: '拖欠中小企业款项投诉需要哪些主体、划型时点、材料和既有受理或处理排除条件？',
    topics: ['complaint-scope', 'complaint-exclusions', 'sme-identity'], terms: ['中小企业', '订立合同时', '不予受理', '已经受理', '投诉材料'],
    requiredIds: profile === 'excluded_identity' ? ['sme-2']
      : profile === 'accepted' ? ['sme-2', 'sme-complaint-7']
        : ['sme-2', 'sme-3', 'sme-24', 'sme-25', 'sme-complaint-6', 'sme-complaint-7'],
    optionalIds: [],
  });
  return queries;
}

function scoreClause(clause, query) {
  const searchable = `${clause.lawTitle} ${clause.article} ${clause.text}`;
  const topicMatches = query.topics.filter((topic) => clause.topics?.includes(topic));
  const lexicalMatches = query.terms.filter((term) => searchable.includes(term));
  return { clauseId: clause.id, score: topicMatches.length * 6 + lexicalMatches.length * 3, topicMatches, lexicalMatches };
}

// This finite corpus search has no semantic/embedding claim: issue queries are
// ranked by explicit topic and lexical matches, then expanded to the narrow
// prerequisites for that issue. Every selected original text has a hard budget.
function retrieve(queries, requestedBudget = {}) {
  // Callers may reduce the server budget for a smaller context window, never
  // enlarge it. Browser case fields are not read as budget configuration.
  const maxClauses = Number.isInteger(requestedBudget?.maxClauses) && requestedBudget.maxClauses >= 1
    ? Math.min(MAX_CLAUSES, requestedBudget.maxClauses) : MAX_CLAUSES;
  const maxCharacters = Number.isInteger(requestedBudget?.maxCharacters) && requestedBudget.maxCharacters >= 1
    ? Math.min(MAX_CHARACTERS, requestedBudget.maxCharacters) : MAX_CHARACTERS;
  const available = LEGAL_CORPUS.filter((clause) => clause && typeof clause.id === 'string'
    && typeof clause.text === 'string' && clause.text.length > 0 && typeof clause.officialUrl === 'string');
  const byId = new Map(available.map((clause) => [clause.id, clause]));
  const selected = new Map();
  let characters = 0;
  const traces = queries.map((query) => {
    const ranked = available.map((clause) => scoreClause(clause, query)).filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score || left.clauseId.localeCompare(right.clauseId));
    const candidateIds = new Set([...ranked.slice(0, 6).map((hit) => hit.clauseId), ...query.requiredIds, ...query.optionalIds]);
    return {
      id: query.id, question: query.question, topics: [...query.topics], terms: [...query.terms],
      candidateCount: ranked.length, clauseIds: [], requiredClauseIds: [...query.requiredIds], missingRequiredClauseIds: [],
      hits: [...candidateIds].filter((id) => byId.has(id)).map((id) => ({ ...scoreClause(byId.get(id), query), selected: false, selection: 'candidate' }))
        .sort((left, right) => right.score - left.score || left.clauseId.localeCompare(right.clauseId)),
    };
  });
  function select(id, trace, selection) {
    const clause = byId.get(id);
    if (!clause) return false;
    if (!selected.has(id)) {
      if (selected.size >= maxClauses || characters + clause.text.length > maxCharacters) return false;
      selected.set(id, clause); characters += clause.text.length;
    }
    if (!trace.clauseIds.includes(id)) trace.clauseIds.push(id);
    const hit = trace.hits.find((item) => item.clauseId === id);
    if (hit) { hit.selected = true; hit.selection = selection; }
    return true;
  }
  // Required conditions across all issues have priority over optional context.
  queries.forEach((query, index) => {
    const trace = traces[index];
    const ranking = new Map(trace.hits.map((hit, rank) => [hit.clauseId, rank]));
    [...query.requiredIds].sort((a, b) => (ranking.get(a) ?? Infinity) - (ranking.get(b) ?? Infinity)).forEach((id) => {
      if (!select(id, trace, 'required-condition-expansion')) trace.missingRequiredClauseIds.push(id);
    });
  });
  queries.forEach((query, index) => {
    const trace = traces[index];
    trace.hits.filter((hit) => query.optionalIds.includes(hit.clauseId) && hit.score > 0)
      .forEach((hit) => select(hit.clauseId, trace, 'ranked-context'));
  });
  return {
    selected, traces,
    result: {
      method: 'deterministic-topic-and-lexical-ranking-with-condition-expansion',
      description: '按案件问题拆分查询，以主题和原文词项计分；补入该问题必要条件，完整原文逐条受预算限制。未使用向量检索或联网实时更新。',
      queries: traces, retrievedClauseIds: [...selected.keys()],
      budget: {
        maxClauses, maxCharacters,
        selectedClauses: selected.size, selectedCharacters: characters,
        textTruncated: false, incompleteRequiredConditions: traces.some((trace) => trace.missingRequiredClauseIds.length > 0),
      },
    },
  };
}

function temporalCitation(clause, queryId, today, input) {
  let temporalStatus;
  let temporalNote;
  if (clause.status !== 'current') {
    temporalStatus = 'verification_required';
    temporalNote = '该条文的版本状态仍待核查，不能据此作确定适用结论。';
  } else if (!dateOnly(clause.effectiveFrom)) {
    temporalStatus = 'verification_required';
    temporalNote = '缺少可校验的施行日期，不能据此选择适用版本。';
  } else if (today < clause.effectiveFrom) {
    temporalStatus = 'not_yet_effective_at_review';
    temporalNote = `该版本在分析日尚未施行；施行日为${clause.effectiveFrom}。不能用于当前确定结论。`;
  } else if (dateOnly(clause.effectiveTo) && today > clause.effectiveTo) {
    temporalStatus = 'outside_version_at_review';
    temporalNote = '分析日不在该版本的效力期间，需重新检索适用版本及衔接规则。';
  } else if ((queryId === 'procedure' && ['civil-procedure-122', 'arbitration-5'].includes(clause.id)) || clause.lawId === 'sme-complaint') {
    temporalStatus = 'provisional_current_procedure';
    temporalNote = `仅作为${today}拟启动程序的现行条文核查线索；实际申请、受理和协议订立日期、过渡规则仍待核查，分析日不能替代这些日期。`;
  } else {
    const fields = clause.lawId === 'arbitration-law'
      ? ['arbitrationAgreementDate'] : ['contractDate', 'legalFactDate'];
    if (fields.some((field) => input[field] !== undefined && input[field] !== '' && !dateOnly(input[field]))) {
      temporalStatus = 'reported_date_invalid';
      temporalNote = '填报的合同、相关事实或仲裁协议日期无效，无法核查版本期间。';
    } else if (fields.some((field) => dateOnly(input[field]) && input[field] > today)) {
      temporalStatus = 'reported_date_in_future';
      temporalNote = '填报的合同、相关事实或仲裁协议日期晚于分析日，不能当作已经发生的事实选择法律版本。';
    } else if (fields.some((field) => !dateOnly(input[field]))) {
      temporalStatus = 'historical_scope_unconfirmed';
      temporalNote = '合同订立、相关法律事实或仲裁协议订立日期尚未补齐；这里只检索到收录版本，不表示该版本已适用于本案。填报到期日不能决定实体法或仲裁协议适用版本。';
    } else if (fields.some((field) => input[field] < clause.effectiveFrom || (dateOnly(clause.effectiveTo) && input[field] > clause.effectiveTo))) {
      temporalStatus = 'historical_version_required';
      temporalNote = '至少一项明确填报的相关日期不在收录版本期间；需要补检历史版本及衔接规则，不能将当前版本自动用于历史关系。日期本身仍未经证明。';
    } else {
      temporalStatus = 'reported_dates_within_version';
      temporalNote = '明确填报的相关日期位于收录版本期间，仅完成时间线索的初筛；日期、法律事实及适用条件均未核验，不等于已确认法律适用。仍须核对原件、完整时间线及衔接或特别规则。';
    }
  }
  return { ...clone(clause), temporalStatus, temporalNote };
}

function evidenceGap(input, key, task) {
  return `${input.evidence?.includes(key) ? '核验已填报持有的' : '补充并核验'}${EVIDENCE_LABELS[key]}：${task}`;
}

function commonEvidence(input) {
  return [
    evidenceGap(input, 'contract', '合同主体、完整条款、补充协议、付款及争议解决条件。'),
    evidenceGap(input, 'delivery', '实际履行范围、交付对象、签收权限及履行日期。'),
    evidenceGap(input, 'acceptance', '验收或结算结果、异议及付款前提是否成就；核对发票与付款的合同关系。'),
    evidenceGap(input, 'reconciliation', '合同价款、已付款、待付款及争议部分，结合银行流水复核余额。'),
    AUTHENTICITY_GAP, TIME_GAP,
  ];
}

function reportedDateClues(input, today, extraFields = []) {
  const fields = ['contractDate', 'legalFactDate', ...extraFields];
  return fields.every((field) => dateOnly(input[field]) && input[field] <= today)
    && input.contractDate <= input.legalFactDate;
}

function reportedEvidence(input, required) { return required.every((id) => input.evidence?.includes(id)); }

function dateGaps(input, today, extraFields = []) {
  const gaps = [];
  for (const field of ['contractDate', 'legalFactDate', ...extraFields]) {
    if (!dateOnly(input[field])) gaps.push(`补充或更正${LABELS[field]}，并提供原始记录核验；其他日期不能代替。`);
    else if (input[field] > today) gaps.push(`${LABELS[field]}晚于分析日，不能作为已发生事实；请核实或更正日期。`);
  }
  if (dateOnly(input.contractDate) && dateOnly(input.legalFactDate) && input.contractDate > input.legalFactDate) {
    gaps.push('填报相关法律事实日期早于合同订立日期，需核实事件定义、合同形成过程及完整时间线，当前不能据此作适用判断。');
  }
  return gaps;
}

function finding({ id, title, queryId, status = 'insufficient', advice, whyApplicable, factIds, missingEvidence, conditions, cautions = [], track = 'legal' }, retrieval, today, input) {
  const trace = retrieval.traces.find((item) => item.id === queryId);
  const citations = trace.clauseIds.map((clauseId) => temporalCitation(retrieval.selected.get(clauseId), queryId, today, input));
  const gaps = [...missingEvidence];
  if (trace.missingRequiredClauseIds.length) {
    gaps.push(`本次语料或上下文预算未能完整收录必要条件条文：${trace.missingRequiredClauseIds.join('、')}；补齐官方原文后重新核查。`);
    status = 'insufficient';
  }
  if (citations.some((citation) => ['verification_required', 'not_yet_effective_at_review', 'outside_version_at_review'].includes(citation.temporalStatus))) {
    gaps.push('所引版本的效力期间或核验状态不能支持本次确定适用，需补充对应历史版本、修法衔接或官方现行文本。');
    status = 'insufficient';
  }
  if (citations.some((citation) => ['historical_version_required', 'reported_date_invalid', 'reported_date_in_future'].includes(citation.temporalStatus))) {
    gaps.push('明确填报日期超出当前版本期间、无效或尚未发生，须先核实日期并补检对应历史版本及衔接规则。');
    if (status !== 'not_applicable') status = 'insufficient';
  }
  if (status === 'conditional' && citations.some((citation) => citation.temporalStatus === 'historical_scope_unconfirmed')) status = 'insufficient';
  return {
    id, actionId: track === 'complaint' ? 'complaint-action' : 'legal-action', track, title,
    status, statusLabel: STATUS_LABELS[status], advice, whyApplicable, factIds: [...new Set(factIds)],
    missingEvidence: [...new Set(gaps)], conditions: [...conditions], cautions: [...cautions], citations,
  };
}

/**
 * Retrieve exact clauses from the reviewed finite corpus and expose the facts,
 * prerequisites and gaps behind each legal proposition. Inputs and inventory
 * markers are never promoted to proved facts. No model output enters this path.
 */
export function buildLegalReview(input, basePlan = {}, { today, materialSummary = [], retrievalBudget } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('法律核查需要案件填报信息。');
  const reviewedAt = reviewDate(today, basePlan);
  const materialFacts = Array.isArray(materialSummary) ? materialSummary.filter((item) => item && typeof item === 'object') : [];
  const performance = hasPerformanceIssue(input);
  const profile = complaintProfile(input);
  const retrieval = retrieve(queryDefinitions(input, performance, profile), retrievalBudget);
  const facts = factManifest(input, materialFacts);
  const factualIds = ['fact-companyName', 'fact-debtorName', 'fact-amount', 'fact-dueDate', 'fact-issueText', 'fact-contractDate', 'fact-legalFactDate', 'fact-evidence-contract', 'fact-evidence-delivery', 'fact-evidence-acceptance', 'fact-evidence-reconciliation'];
  const future = dateOnly(input.dueDate) && input.dueDate > reviewedAt;
  const datesReported = reportedDateClues(input, reviewedAt);
  const paymentEvidenceReported = reportedEvidence(input, ['contract', 'delivery', 'acceptance', 'reconciliation']);
  const paymentConditional = datesReported && paymentEvidenceReported && input.acceptanceStatus === 'passed'
    && !performance && !future && dateOnly(input.dueDate) && input.dueDate >= input.contractDate;
  const findings = [finding({
    id: 'payment-claim', title: '合同付款请求的事实与法条核查', queryId: 'payment',
    status: paymentConditional ? 'conditional' : 'insufficient',
    advice: future
      ? '填报到期日尚未来临，当前不能据此认定已发生到期未付。先核对付款前提及到期安排；若主张其他提前救济，须另行检索依据。'
      : '先核验合同义务、实际履行、付款条件与未付余额；证据和适用版本补齐后，再评估具体付款请求。',
    whyApplicable: '用户填报存在合同待付款项，因此检索合同金钱债务条文作为待核查的请求权线索。填报金额、到期日和持有材料均未被证明，当前不能确认请求权已经成立。',
    factIds: factualIds,
    missingEvidence: [...commonEvidence(input), ...dateGaps(input, reviewedAt), ...(future ? ['核实是否确已届至合同约定的付款期限；如另有提前到期事由，补充该独立事由及法律依据。'] : [])],
    conditions: ['确认真实、有效且由相应当事人承担的合同付款义务。', '结合约定和实际履行核实付款条件、期限及准确未付金额。', '核查履行抗辩、抵销、已支付或其他影响请求的事项。', '以实际法律事实日期选择适用版本，并核查需要补充的特别法。'],
    cautions: ['所引一般合同条文不能替代对合同性质、具体事实或特别规则的审查。', '不据此自动计算利息、违约金或认定对方责任。'],
  }, retrieval, reviewedAt, input)];
  if (performance) findings.push(finding({
    id: 'performance-defense', title: '履约、验收异议与付款抗辩条件', queryId: 'performance',
    status: datesReported && reportedEvidence(input, ['contract', 'delivery', 'acceptance', 'repair']) ? 'conditional' : 'insufficient',
    advice: '把具体履约异议、双方义务顺序及对应金额逐项核对；符合哪一种抗辩、可以拒绝何种范围，均须依合同和证据另行判断。',
    whyApplicable: '填报问题或验收状态涉及履约异议，可能与同时履行或先履行抗辩有关。检索两类条文用于区分条件，不能仅因存在维修或验收争议就认定可以拒付全部款项。',
    factIds: ['fact-projectType', 'fact-issueText', 'fact-issueTypes', 'fact-acceptanceStatus', 'fact-contractDate', 'fact-legalFactDate', 'fact-evidence-contract', 'fact-evidence-acceptance', 'fact-evidence-repair'],
    missingEvidence: [...commonEvidence(input), ...dateGaps(input, reviewedAt), evidenceGap(input, 'repair', '具体缺陷、发现时间、成因、通知与整改情况；确无质量问题时注明不适用。'), '合同中双方互负义务、履行先后顺序及争议义务与拒付金额的对应关系。'],
    conditions: ['核实是否互负对待给付义务以及有无先后履行顺序。', '核实对方未履行或履行不符合约定的具体事项及程度。', '分别判断相应履行要求及抗辩范围，不把项目协调安排当作责任认定。'],
    cautions: ['没有预先认定质量责任、整改责任或拒付权成立。', '买卖、承揽、建设工程等特别规则尚未完整覆盖，合同性质明确后应另行补检。'],
  }, retrieval, reviewedAt, input));
  const arbitration = input.disputeClause === 'arbitration';
  const unknownClause = !['court', 'arbitration'].includes(input.disputeClause);
  findings.push(finding({
    id: 'dispute-procedure', title: arbitration ? '仲裁协议与程序版本核查' : '起诉条件、管辖与仲裁排除核查', queryId: 'procedure',
    status: !unknownClause && input.disputeAccepted === 'no' && reportedDateClues(input, reviewedAt, arbitration ? ['arbitrationAgreementDate'] : [])
      && reportedEvidence(input, ['contract', 'delivery', 'reconciliation']) ? 'conditional' : 'insufficient',
    advice: arbitration
      ? '先核查仲裁协议原文、订立日期、争议范围及机构约定，再确认应适用的协议效力规则和实际申请程序。'
      : unknownClause ? '争议条款尚不明确，当前不能选定诉讼或仲裁。先取得完整合同与补充协议，再核对管辖和受理条件。'
        : '用户选择法院路径仍须核实管辖、起诉材料及是否另有有效仲裁协议；符合相应条件后才评估提交。',
    whyApplicable: arbitration
      ? '用户填报存在仲裁约定，故检索仲裁协议的必要条件和无效情形。现行仲裁法施行日与协议订立时间须分别核查，不能自动把新法用于旧协议。'
      : '争议解决需要核对起诉条件及有效仲裁协议的影响。用户选项不能证明管辖约定、仲裁约定有效或法院已应受理。',
    factIds: ['fact-disputeClause', 'fact-disputeAccepted', 'fact-companyName', 'fact-debtorName', 'fact-contractDate', 'fact-legalFactDate', 'fact-arbitrationAgreementDate', 'fact-evidence-contract'],
    missingEvidence: [
      evidenceGap(input, 'contract', '争议条款全文、补充协议、签订过程及各版本签订日期。'),
      ...(unknownClause ? ['争议解决约定尚未明确，需先核实是否存在有效且覆盖本争议的仲裁协议。'] : []),
      arbitration ? '仲裁协议订立日期、当事人意思表示、争议范围、机构约定及可能的无效或约定不明情形；旧协议另查历史版本和衔接规则。' : '双方主体资格、明确的被告、具体请求及事实理由、法院管辖依据、是否存在其他有效仲裁协议。',
      '实际拟申请、受理日期及既有程序记录；分析日期仅用于展示当前程序核查线索。', AUTHENTICITY_GAP, TIME_GAP,
      ...dateGaps(input, reviewedAt, arbitration ? ['arbitrationAgreementDate'] : []),
    ],
    conditions: arbitration
      ? ['核实协议成立、有效、内容明确并覆盖本次争议。', '按协议订立及相关事实日期核查适用版本和过渡规则。', '核查实际申请时机构规则、受理范围与程序要求。']
      : ['核实起诉的主体、被告、诉讼请求、事实理由及管辖条件。', '核查是否存在有效且覆盖本争议的仲裁协议及其对法院受理的影响。', '核对实际启动程序时的现行规则及历史协议的效力规则。'],
    cautions: ['填报到期日不是仲裁协议订立日，也不是起诉或仲裁申请日。', '未核实协议与请求前，不认定可以受理；保全、费用、执行等另行核查。'],
  }, retrieval, reviewedAt, input));
  const limitationTrace = retrieval.traces.find((item) => item.id === 'limitation');
  if (limitationTrace.clauseIds.length) findings.push(finding({
    id: 'limitation-review', title: '请求权时效的时间线核查', queryId: 'limitation',
    status: datesReported && reportedEvidence(input, ['contract', 'collection']) ? 'conditional' : 'insufficient',
    advice: '整理知道或应当知道权利受损及义务人、催告送达、承诺履行、诉讼或仲裁等完整时间线，由法务结合适用版本核查时效。',
    whyApplicable: '付款请求涉及时间线核查，因此检索一般时效及中断条文。填报到期日和逾期天数不足以确定起算、中止、中断或是否届满。',
    factIds: ['fact-dueDate', 'fact-issueText', 'fact-contractDate', 'fact-legalFactDate', 'fact-evidence-collection', 'fact-disputeAccepted'],
    missingEvidence: [TIME_GAP, ...dateGaps(input, reviewedAt), evidenceGap(input, 'collection', '每次请求内容、作出与送达时间、对象、回执及对方承诺履行记录。'), '核实权利受损及义务人知悉时间、既有申请或受理、中止事由等；中止及其他特别规则尚须补检。', AUTHENTICITY_GAP],
    conditions: ['先确认请求权性质及应适用的一般或特别时效规则。', '逐项核查起算、中断及可能的中止事实和证明。', '历史法律事实超出当前语料版本时另查当时规则和衔接规则。'],
    cautions: ['本核查没有计算届满日期，也没有认定请求权因时效而消灭或已经失效。'],
  }, retrieval, reviewedAt, input));
  const excluded = ['accepted', 'excluded_identity'].includes(profile);
  const complaintGaps = [
    '核验债权人在订立合同时的中小企业划型依据及行业、人数、营业收入、资产等相应指标，不能以当前自选标签替代。',
    '核验付款方是否为条例范围内的机关、事业单位或大型企业，核查交易与款项性质。',
    '同一事项是否已有法院、仲裁机构、其他行政管理部门或社会调解机构受理或者处理；核对事项同一性与记录。',
    '核查官方投诉受理范围、具体受理单位、有效联系方式及投诉材料的签署或盖章要求。',
    ...commonEvidence(input), ...dateGaps(input, reviewedAt),
  ];
  findings.push(finding({
    id: 'sme-complaint', title: '拖欠中小企业款项投诉适用条件核查', queryId: 'complaint', track: 'complaint',
    status: excluded ? 'not_applicable' : profile === 'eligible_reported' && datesReported && !future && input.acceptanceStatus === 'passed'
      && reportedEvidence(input, ['contract', 'delivery', 'acceptance', 'reconciliation', 'collection']) ? 'conditional' : 'insufficient',
    advice: profile === 'accepted'
      ? '按填报已有受理或处理记录，本次不能建议直接提交同一事项的该投诉。先核验具体记录并对照不予受理情形。'
      : profile === 'excluded_identity' ? '按当前填报的主体组合，该中小企业款项投诉路径不适用；若主体标签有误，核实并更正后重新评估。'
        : profile === 'unknown_identity' ? '主体身份或订立合同时划型依据不足，暂不能认定适用该投诉机制；先核实主体与交易范围。'
          : profile === 'unknown_acceptance' ? '先查清同一事项的既有受理或处理状态，再核查投诉主体、材料及排除条件。'
            : '填报主体组合仅提供投诉核查线索；先核实订立合同时划型、交易范围、既有程序及材料后，再决定是否提交。',
    whyApplicable: '根据填报的企业规模、付款方类型和既有程序状态检索专项投诉规则。范围条文、材料要求和不予受理情形分别核查，当前填报并未证明投诉资格或受理条件。',
    factIds: ['fact-creditorSize', 'fact-debtorType', 'fact-disputeAccepted', 'fact-companyName', 'fact-debtorName', 'fact-contractDate', 'fact-legalFactDate', 'fact-evidence-contract', 'fact-evidence-collection'],
    missingEvidence: complaintGaps,
    conditions: ['在订立合同时属于中小企业，付款方属于机关、事业单位或大型企业，并核实相关交易、款项范围。', '符合当前适用投诉规则的材料及签署或盖章要求。', '排除法院、仲裁机构、其他行政管理部门或社会调解机构已经受理或者处理等不予受理情形。', '核实实体交易及投诉程序各自日期、适用版本和受理机关当前指南。'],
    cautions: ['投诉不直接替代民事确权或执行，也不预示受理或回款结果。', '不因填报尚无受理记录就认定全部排除条件已被排除。'],
  }, retrieval, reviewedAt, input));
  const limitations = [
    COVERAGE_NOTE,
    '这是有限官方条文语料的确定性检索与条件核查，未查询实时裁判、企业登记或其他案件；没有完整覆盖特别法、司法解释、历史版本和修法衔接规则。',
    '全部案件事实均为用户填报或材料清单，verification 均为 unverified；没有把证据勾选、附件或模型识别当作真实性、有效性或法律责任的验证。',
    dateGaps(input, reviewedAt, arbitration ? ['arbitrationAgreementDate'] : []).length
      ? '合同订立、相关事实或仲裁协议日期仍有缺口或待更正；分析日与付款到期日不能补足。实体法适用版本、完整时间线及实际程序日期均须核查。'
      : '已填报的合同、相关事实或仲裁协议日期仅为未经核验的时间线索；处于收录版本期间也不等于法律已经适用，完整时间线和实际程序日期仍须核查。',
    '每项建议只列明可能相关的依据、条件与缺口，不认定债权成立、诉讼时效届满、管辖或投诉受理条件已经满足。',
  ];
  const civilDates = LEGAL_CORPUS.filter((item) => item.lawId === 'civil-code').map((item) => item.effectiveFrom).filter(dateOnly).sort();
  if (dateOnly(input.dueDate) && civilDates.length && input.dueDate < civilDates[0]) {
    limitations.push('填报到期日早于已收录民法典版本的施行日，提示可能涉及语料未覆盖的历史规则；这不等于认定该日就是法律事实发生日，须核实完整日期并补检历史法和衔接规则。');
  }
  return freeze({
    schemaVersion: '1.0', reviewedAt, jurisdiction: '中国大陆', corpusVersion: CORPUS_VERSION,
    coverageNote: COVERAGE_NOTE, facts, retrieval: retrieval.result, findings,
    businessActionIds: (basePlan.actions ?? []).filter((action) => ['business', 'repair'].includes(action.track)).map((action) => action.id),
    limitations,
  });
}

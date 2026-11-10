const DAY_MS = 86_400_000;
const ISSUE_TYPES = new Set(['repair', 'acceptance', 'invoice', 'cashflow', 'dispute', 'unresponsive']);
const EVIDENCE_DEFINITIONS = [
  { id: 'contract', label: '合同及补充协议', reason: '核对付款条件、履约义务、争议解决条款及送达信息。' },
  { id: 'delivery', label: '交付或服务履行记录', reason: '核查交货、安装、服务范围及实际履行情况。' },
  { id: 'acceptance', label: '验收与项目结算资料', reason: '核对验收结果、异议及付款节点，不能仅以单方描述认定已验收。' },
  { id: 'invoice', label: '发票及开票沟通记录', reason: '核对开票与付款约定，是否影响付款须结合合同审查。' },
  { id: 'reconciliation', label: '对账单及付款流水', reason: '核对金额、已付款和争议款；持有对账单不代表对方已经确认。' },
  { id: 'collection', label: '催收沟通及送达记录', reason: '留存沟通过程，具体法律效果须核查内容、时间及是否送达。' },
  { id: 'repair', label: '故障、维修与整改记录', reason: '核查故障原因、责任边界、维修计划及恢复运行情况。' },
];

export const EVIDENCE_ITEMS = EVIDENCE_DEFINITIONS.map(({ id, label }) => ({ id, label }));

function dateValue(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`请填写有效的${label}，格式为年-月-日。`);
  }
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 2199) throw new Error(`${label}年份须在1900至2199之间。`);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`请填写真实存在的${label}。`);
  }
  return timestamp;
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function oneOf(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

function money(amount) {
  return amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function inferIssues(description, supplied) {
  const issues = new Set(Array.isArray(supplied) ? supplied.filter((id) => ISSUE_TYPES.has(id)) : []);
  const cleaned = description
    .replace(/(?:没有|不存在|无|无需|不需要)(?:任何)?(?:设备)?(?:故障|维修|质量问题|验收争议|发票问题|运行不稳定|运转不稳定|异常)/g, '')
    .replace(/(?:已|已经)(?:完成)?(?:维修|验收|开票)/g, '');
  const patterns = {
    repair: /故障|维修|检修|停机|宕机|返修|设备损坏|质量异议|质量争议|质量问题|运行不稳定|运转不稳定|设备异常|无法启动|无法运行/,
    acceptance: /未验收|待验收|拒绝验收|验收未通过|验收争议|尚未验收|结算未完成|尚未结算/,
    invoice: /未开票|没开票|发票未|开票争议|开票问题|发票问题/,
    cashflow: /资金紧张|资金困难|资金周转|现金流|暂时无力|分期/,
    dispute: /金额争议|结算争议|合同争议|不认可|扣款|拒付/,
    unresponsive: /失联|不回复|不回应|联系不上|无人接听|拒接/,
  };
  for (const [id, pattern] of Object.entries(patterns)) if (pattern.test(cleaned)) issues.add(id);
  return issues;
}

function evidenceList(ids, needsRepair) {
  return EVIDENCE_DEFINITIONS.filter((item) => item.id !== 'repair' || needsRepair)
    .map((item) => ({ ...item, present: ids.has(item.id) }));
}

/**
 * Generate an explainable, local demonstration plan. All entered facts and
 * evidence flags remain user statements; this function does not verify them.
 * Date-only arithmetic is UTC-based so time zones do not shift overdue days.
 */
export function generatePlan(input, today = '2026-11-10') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请先填写项目情况。');
  const amount = input.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('请填写大于0的欠款金额，单位为元。');
  }
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(amount * 100 - cents) > 0.00001) {
    throw new Error('金额最多保留两位小数，且须在可准确计算的范围内。');
  }
  const dueTimestamp = dateValue(input.dueDate, '付款到期日');
  const todayTimestamp = dateValue(today, '分析日期');
  const description = text(input.issueText);
  if (!description) throw new Error('请描述项目目前存在的问题。');
  if (description.length > 6000) throw new Error('项目问题请控制在6000字以内。');

  const companyName = text(input.companyName);
  const debtorName = text(input.debtorName);
  const projectType = oneOf(input.projectType, ['equipment', 'general', 'construction'], 'equipment');
  const debtorType = oneOf(input.debtorType, ['enterprise', 'large', 'government', 'institution'], 'enterprise');
  const creditorSize = oneOf(input.creditorSize, ['unknown', 'sme', 'large'], 'unknown');
  const acceptanceStatus = oneOf(input.acceptanceStatus, ['unknown', 'passed', 'pending', 'disputed'], 'unknown');
  const disputeClause = oneOf(input.disputeClause, ['unknown', 'court', 'arbitration'], 'unknown');
  const disputeAccepted = oneOf(input.disputeAccepted, ['unknown', 'no', 'yes'], 'unknown');
  const issues = inferIssues(description, input.issueTypes);
  const evidence = new Set(Array.isArray(input.evidence) ? input.evidence.filter((id) => EVIDENCE_DEFINITIONS.some((item) => item.id === id)) : []);
  const dayDifference = Math.round((todayTimestamp - dueTimestamp) / DAY_MS);
  const overdueDays = Math.max(0, dayDifference);
  const future = dayDifference < 0;
  const dueToday = dayDifference === 0;
  const hasRepair = issues.has('repair');
  const acceptanceIssue = issues.has('acceptance') || ['pending', 'disputed'].includes(acceptanceStatus);
  const projectBlockage = hasRepair || acceptanceIssue;
  const hasDispute = issues.has('dispute') || acceptanceStatus === 'disputed';
  const missingKeyEvidence = !evidence.has('contract') || !evidence.has('delivery') || !evidence.has('reconciliation');
  const eligibleComplaintProfile = creditorSize === 'sme' && ['large', 'government', 'institution'].includes(debtorType);
  const complaintCanExplore = eligibleComplaintProfile && disputeAccepted === 'no';
  const projectLabel = { equipment: '设备销售 / 安装维保', general: '一般企业应收账款', construction: '工程项目结算' }[projectType];
  const debtorLabel = { enterprise: '普通企业', large: '大型企业', government: '机关', institution: '事业单位' }[debtorType];
  const acceptanceLabel = { unknown: '待核实', passed: '用户填报已通过，待核对资料', pending: '待验收 / 结算', disputed: '存在验收 / 结算异议' }[acceptanceStatus];
  const dueLabel = future ? `距填报到期日还有${Math.abs(dayDifference)}天` : dueToday ? '填报到期日为今天' : `较填报到期日已过${overdueDays}天`;

  let priority;
  if (!future && (overdueDays >= 180 || amount >= 500000)) {
    priority = { label: '优先统筹', tone: 'high', reason: '演示排序规则：已到期且逾期达到180天，或金额达到50万元；用于安排内部跟进顺序，不代表法律结论或回款概率。' };
  } else if (projectBlockage || hasDispute || overdueDays >= 30 || amount >= 100000) {
    priority = { label: '协调推进', tone: 'medium', reason: '金额、逾期情况或项目争议触发内部协调建议；排序阈值仅用于本演示，不代表法律定性。' };
  } else {
    priority = { label: '常规跟进', tone: 'low', reason: '先核对付款条件及履约资料，按明确的商务节点跟进；本标签不代表付款方信用或回款承诺。' };
  }

  const missingInfo = [];
  if (!companyName) missingInfo.push('补充债权人名称及业务联系人。');
  if (!debtorName) missingInfo.push('补充付款方准确名称、联系人及可确认的送达地址。');
  if (!evidence.has('contract')) missingInfo.push('提供合同与补充协议，核查到期条件、维修责任及争议条款。');
  if (!evidence.has('delivery')) missingInfo.push('补充交货、安装、服务或工程履行记录。');
  if (!evidence.has('reconciliation')) missingInfo.push('核对合同总额、已付款、争议款和无争议款，形成可追溯的对账记录。');
  if (acceptanceStatus === 'unknown' || !evidence.has('acceptance')) missingInfo.push('确认验收或结算状态及相应资料，不能直接假定付款条件全部成就。');
  if (hasRepair && !evidence.has('repair')) missingInfo.push('补充故障描述、现场记录、售后责任约定及已有维修工单。');
  if (disputeClause === 'unknown') missingInfo.push('核查合同是否存在有效仲裁约定或管辖约定。');
  if (creditorSize === 'unknown') missingInfo.push('核实本公司在相关交易中的中小企业划型及投诉渠道适用条件。');
  if (eligibleComplaintProfile && disputeAccepted === 'unknown') missingInfo.push('确认是否已有法院、仲裁机构等受理或处理，避免重复选择不受理的投诉路径。');

  const strategy = future
    ? `${projectBlockage ? '先处理履约与验收事项，' : ''}核实填报到期日及付款条件，提前确认付款计划；当前输入尚未到期，不按逾期催收处理。`
    : projectBlockage
      ? '维修整改或验收协调与商务对账同步推进，先界定争议部分和无争议部分，再按合同与证据选择法务或适用投诉路径。'
      : '先核对金额和付款条件，形成书面付款安排；未履行时根据合同争议条款、证据及渠道受理范围逐步升级。';

  const actions = [];
  if (hasRepair || acceptanceIssue || projectType === 'equipment') {
    const repairTitle = hasRepair
      ? (projectType === 'equipment' ? '设备检修与回款节点联动' : '履约整改与回款节点联动')
      : acceptanceIssue ? '完成验收与结算事项核对' : '核对交付与售后状态';
    actions.push({
      id: 'repair-action', track: 'repair', title: repairTitle, priority: projectBlockage ? '优先' : '并行',
      owner: projectType === 'equipment' ? '售后 / 项目负责人' : '项目负责人', timing: '建议首轮沟通时明确，按双方确认计划执行',
      reason: hasRepair ? '用户描述涉及维修或故障，需要核实其与付款争议的关系，不能直接认定故障责任。' : acceptanceIssue ? '验收或结算事项可能影响付款节点，需要结合合同及实际履行核查。' : '设备类项目先核对交付与售后状态，避免遗漏实际影响付款的事项。',
      steps: hasRepair ? [
        '安排双方确认故障清单、现场检查方式、责任边界和维修范围；不要在核查前承认责任。',
        '形成维修工单、预计完成节点及复验标准；确有安全隐患时按适用要求安排专业处置。',
        '将已确认维修或复验节点与付款沟通衔接，另行核对无争议款项；不得擅自停机、锁机或取回设备。',
      ] : [
        '核对交付、安装、验收或结算条件及尚待双方完成的事项。',
        '确有异议时形成具体事项清单与处理计划；没有故障依据时无需额外安排维修。',
        '取得项目状态记录，将无争议部分与待核查部分分别对账。',
      ],
      materials: ['合同及售后约定', ...(hasRepair ? ['故障或维修工单', '现场检查与复验记录'] : ['交付及验收记录'])],
      condition: '根据真实项目问题安排；整改责任、费用和付款影响均须结合合同与资料确认。', sourceIds: ['civil-code'],
    });
  }

  actions.push({
    id: 'business-action', track: 'business', title: future ? '确认到期付款安排' : '对账并落实书面付款安排', priority: '优先',
    owner: '客户经理 / 财务', timing: future ? '到期前完成核对；到期后按实际履行跟进' : '建议1—3个工作日内启动；具体期限双方协商',
    reason: '金额与到期日为用户填报，需要先与合同、流水和实际履行对应，沟通记录不能替代债权核验。',
    steps: [
      '核对合同总额、发票、已付款、待付金额和各付款条件，分别列明争议部分与无争议部分。',
      future ? '与付款方确认到期付款负责人、资料要求和付款计划，避免把未到期款项当作逾期债务。' : '请付款方书面反馈付款安排；可以协商分期、对账或调解，记录日期、金额及条件。',
      '保存原始往来与送达记录；利息、违约金或其他费用需单独核查合同和适用规则，不自动加收。',
    ],
    materials: ['合同及付款节点', '付款流水与对账资料', '项目异议及沟通记录'],
    condition: '只就已核实的金额和条件提出具体主张；方案中的时间安排为协作建议，不是法定期限。', sourceIds: ['civil-code'],
  });

  let legalTitle;
  let legalSteps;
  if (disputeClause === 'arbitration') {
    legalTitle = '先核查仲裁约定，再评估仲裁路径';
    legalSteps = [
      '核验仲裁条款的有效性、约定机构及争议范围，必要时由法务审查。',
      '按核验结果与机构规则准备材料；存在有效且覆盖争议的仲裁约定时，不直接按普通起诉流程推进。',
      '如需保全等措施，单独核查法定条件、担保及办理途径；是否采取由法务评估。',
    ];
  } else if (disputeClause === 'court') {
    legalTitle = '核对管辖与材料，评估民事诉讼';
    legalSteps = [
      '核验管辖约定、主体身份、合同履行及金额资料，确认是否存在其他有效仲裁约定。',
      '评估具体请求、证据、诉讼时效及成本，条件具备后再准备起诉材料。',
      '通过人民法院官方服务入口查询办理要求；保全、费用与送达事项须结合实际核查。',
    ];
  } else {
    legalTitle = '先核查争议条款与证据，再选择诉讼或仲裁';
    legalSteps = [
      '调取完整合同和补充协议，核查仲裁约定、管辖约定及其有效性。',
      '核实付款请求的事实、金额、证据及时间线，由法务评估诉讼、仲裁或调解路径。',
      '路径确认后再准备对应文书，不能仅凭欠款金额或天数直接判断可以起诉。',
    ];
  }
  if (missingKeyEvidence) legalSteps.unshift('先补齐合同、履约和金额资料，当前勾选情况不足以代表案件已具备起诉或仲裁条件。');
  if (future) legalSteps.unshift('目前填报到期日尚未来临，先核查是否有其他明确争议及相应请求依据。');
  actions.push({
    id: 'legal-action', track: 'legal', title: legalTitle, priority: '条件满足后', owner: '公司法务 / 律师',
    timing: '完成事实、合同与证据核验后决定；法定期限另行核查',
    reason: missingKeyEvidence ? '核心资料尚待核对，现阶段适合进行法务材料审查，不能认定诉讼条件已经满足。' : '已勾选材料仍需核验内容和效力，争议路径及法律主张取决于完整事实与合同。',
    steps: legalSteps,
    materials: ['当事人身份及合同', '交付、验收、对账与付款证据', '沟通送达及完整事件时间线'],
    condition: '有效争议解决约定、请求依据、管辖或仲裁机构及证据需经核查；不保证受理、胜诉或执行回款。',
    sourceIds: disputeClause === 'arbitration' ? ['arbitration-law', 'civil-code'] : ['civil-code', 'arbitration-law', 'court-service'],
  });

  let complaintTitle;
  let complaintReason;
  let complaintSteps;
  if (eligibleComplaintProfile && disputeAccepted === 'yes') {
    complaintTitle = '已有受理记录，先核查投诉排除情形';
    complaintReason = '用户填报已有法院、仲裁机构等受理或处理；相关投诉规则可能排除已进入处理程序的事项，不能默认可以受理。';
    complaintSteps = [
      '先核实已有受理或处理的机构、事项、案号和当前状态。',
      '对照拖欠中小企业款项投诉办理规则核查排除情形，不把投诉与诉讼或仲裁直接并行。',
      '按已选合法程序推进，必要时向受理机关咨询其他可用的事项反映途径。',
    ];
  } else if (eligibleComplaintProfile) {
    complaintTitle = complaintCanExplore ? '核查中小企业款项投诉路径' : '先核实受理状态，再评估中小企业款项投诉';
    complaintReason = '按用户选择，本公司为中小企业且付款方为机关、事业单位或大型企业，可进一步核查相关条例与渠道的适用条件。';
    complaintSteps = [
      '核实双方身份与企业划型、交易与款项性质、付款条件及投诉受理范围。',
      disputeAccepted === 'unknown' ? '先确认同一事项是否已有法院、仲裁机构等受理或处理，排除不受理情形后再选择渠道。' : '再次核对同一事项的受理或处理状态及排除情形，再决定是否提交投诉。',
      '核查官方办事指南及受理机关，提交真实合同、履约和催款资料；投诉不直接替代民事确权或执行。',
    ];
  } else {
    complaintTitle = creditorSize === 'unknown' ? '确认主体条件与可用投诉渠道' : '核查是否存在特定主管渠道';
    complaintReason = creditorSize === 'unknown' ? '本公司中小企业划型尚未确认，暂不能认定适用拖欠中小企业款项投诉机制。' : '当前主体组合不能直接认定适用拖欠中小企业款项投诉机制；普通企业货款争议通常需按合同争议路径处理。';
    complaintSteps = [
      '核实企业划型、付款方身份、款项性质及是否存在特定行业主管职责。',
      '有真实且属于主管机关职责的线索时再向对应官方渠道咨询，不以投诉代替合同争议解决。',
      '纯企业货款纠纷不默认使用12315消费投诉；如另有独立违法线索，需按实际事项另行核实。',
    ];
  }
  actions.push({
    id: 'complaint-action', track: 'complaint', title: complaintTitle, priority: '条件满足后', owner: '法务 / 企业服务负责人',
    timing: '主体、事项及受理排除条件核查后择路推进', reason: complaintReason, steps: complaintSteps,
    materials: ['双方主体与企业划型材料', '合同、履约与款项资料', '催款记录及既有受理情况'],
    condition: '以官方现行指南与具体机关受理范围为准；不默认与诉讼或仲裁同时受理，也不承诺投诉能够直接追回款项。',
    sourceIds: ['sme-payment', 'sme-complaint', 'market-complaint'],
  });

  const caution = [
    '这是基于用户输入与演示规则生成的跟进建议；未接入实时案情审查，不代表胜诉、受理或回款承诺。',
    '勾选材料仅表示用户称已持有，不代表材料真实、完整、已获对方认可或具备证明力。',
    '付款到期日和金额仍需结合合同与履约条件核实；不自动计算利息、违约金或损失。',
    '不得采取威胁、骚扰、公开个人信息或未经授权停机、锁机、取回设备等催收手段。',
    '投诉、诉讼与仲裁应先核查各自适用条件；对同一事项不要默认多渠道并行受理。',
  ];
  if (overdueDays >= 730) caution.push('填报时间跨度较长，应核查请求权起算、催收送达、时效中断或中止等完整情况；仅凭逾期天数不能认定已经超过诉讼时效。');
  if (hasRepair) caution.push('故障原因、保修义务和维修费用尚需核实；本方案不认定任何一方承担质量责任。');

  const timeline = [
    { phase: '01', title: future ? '到期前核对' : '事实与材料核对', items: ['核对主体、合同、金额和到期条件', '列明争议与无争议部分，补齐关键材料'] },
    { phase: '02', title: projectBlockage ? '履约协同与商务沟通' : '确认付款计划', items: projectBlockage ? ['核查故障、验收或结算事项并形成双方计划', '同步协商无争议部分的支付安排'] : ['与付款方确认付款负责人、节点及书面回复', '留存对账、付款与送达记录'] },
    { phase: '03', title: '核查后选择升级路径', items: [disputeClause === 'arbitration' ? '核查有效仲裁约定及对应机构规则' : '核查合同约定，再评估诉讼、仲裁或调解', '满足主体、事项及排除条件后再评估投诉路径'] },
  ];

  const letterDraft = [
    '回款与项目事项沟通函（草稿）',
    '',
    `致：${debtorName || '[付款方名称待补充]'}`,
    '',
    `我方目前登记的待核对款项为人民币${money(amount)}元，填报付款到期日为${input.dueDate}。上述金额和付款条件仍需双方结合合同、履约及结算资料核对。`,
    `拟共同核实的项目事项：${description}`,
    '',
    future ? '请协助核对到期付款所需资料，并共同确认到期付款安排。' : '请协助核对争议与无争议部分，并就可确认的应付款项反馈付款计划。',
    ...(projectBlockage ? ['如存在维修、验收或结算待办事项，请共同确认具体清单、责任核查方式和完成节点；本函不预先认定质量责任。'] : []),
    '如需分期或进一步协商，请提出具体日期、金额和条件，双方另行书面确认。请于[双方确认的回复日期]前反馈。',
    '',
    '本函为业务沟通草稿；具体权利主张以核验后的事实、合同及适用规则为准。',
    '',
    `发函方：${companyName || '[债权人名称待补充]'}`,
    '联系人及联系方式：[待补充]',
    `日期：${today}`,
  ].join('\n');

  return {
    summary: `用户填报待核对款项为${money(amount)}元；${dueLabel}。${projectBlockage ? '描述中存在履约、维修或验收事项，建议先协调核实。' : '建议从金额、付款条件和书面安排核对开始。'}`,
    overdueDays, amount, priority, strategy,
    facts: [
      { label: '本公司', value: companyName || '未填写' },
      { label: '付款方', value: debtorName || '未填写' },
      { label: '业务类型', value: projectLabel },
      { label: '填报金额', value: `¥${money(amount)}（待对账）` },
      { label: '填报付款到期日', value: input.dueDate },
      { label: '相对分析日期', value: dueLabel },
      { label: '付款方类型', value: `${debtorLabel}（用户选择）` },
      { label: '验收 / 结算状态', value: acceptanceLabel },
      { label: '项目问题（用户输入）', value: description },
    ],
    missingInfo, actions, timeline,
    evidenceChecklist: evidenceList(evidence, hasRepair), caution, letterDraft, generatedAt: today,
  };
}

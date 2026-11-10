// Account-scoped manual receivables. Calculations come from the overview API.
let context;
const state = { payload: { records: [], ledgers: [], legalEvents: [], timeline: [] }, filters: null, sequence: 0, dirty: new Set(), dialogs: [], busy: false };
const $ = (id) => document.getElementById(id);
const labels = {
  invoice: { unconfirmed: '开票待确认', not_issued: '未开票', recorded: '已登记发票' },
  finance: { unconfirmed: '财务待确认', confirmed: '财务已确认', not_recognized: '未确认为财务应收' },
  payment: { unconfirmed: '付款节点待确认', conditional: '付款条件待成就', confirmed: '付款节点已确认' },
  maturity: { not_due: '尚未到期', due_today: '今日到期', overdue: '已逾期', no_unpaid: '已登记未收为零', unknown: '到期情况待确认' },
  delivery: { unknown: '送达情况待确认', pending: '待送达', served: '已送达', not_served: '未送达' },
  types: { contract: '合同订立', performance: '履约 / 验收', collection: '催收', promise: '付款承诺', acknowledgment: '债务确认', payment: '收付款', filing: '立案申请', acceptance: '案件受理', hearing: '开庭', judgment: '裁判 / 调解', enforcement: '执行', suspension: '中止 / 中断相关事项', other: '其他事项' },
  sources: { legal_event: '法律事项', legal_delivery: '填报送达日期', legal_reminder: '内部提醒', legal_deadline: '人工登记法律期限', case_input: '案件填报参考', note: '跟进登记' },
};
function node(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined && text !== null) n.textContent = String(text); return n; }
function btn(text, action, className = 'button secondary small') { const b = node('button', className, text); b.type = 'button'; if (action) b.addEventListener('click', action); return b; }
function money(value) { return value === null || value === undefined || value === '' ? '待确认' : '¥ ' + Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function date(value) { return value || '待确认'; }
function time(value) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d); }
function recordFor(id) { return (state.payload.records || []).find((r) => r.id === id); }
function recordName(r) { return r ? [r.number, r.input?.debtorName || r.debtorName || '客户待填写', r.title].filter(Boolean).join(' · ') : '关联案件暂不可读'; }
function errorAt(target, error) { target.textContent = error?.message || '操作未完成，请重试。'; target.hidden = false; }
function line(parent, label, text, className = '') { const row = node('div', 'overview-data-row ' + className); row.append(node('span', '', label), node('strong', '', text)); parent.append(row); }
function empty(text) { return node('div', 'panel overview-empty', text); }
function openCase(id) { Promise.resolve(context.openRecord(id)).catch((error) => errorAt($('overview-error'), error)); }

export function initOverview(options) {
  if (context) return;
  context = options;
  $('overview-refresh').addEventListener('click', refreshOverview);
  $('overview-case-status').addEventListener('change', refreshOverview);
  let timer;
  $('overview-search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refreshOverview, 250); });
  $('overview-add-ledger').addEventListener('click', () => openLedger());
  $('overview-add-event').addEventListener('click', () => openEvent());
  const tabs = [...document.querySelectorAll('[data-overview-tab]')];
  const select = (button) => { for (const b of tabs) { const selected = b === button; b.classList.toggle('active', selected); b.setAttribute('aria-selected', String(selected)); b.tabIndex = selected ? 0 : -1; $('overview-' + b.dataset.overviewTab).hidden = !selected; } };
  for (const b of tabs) { b.addEventListener('click', () => select(b)); b.addEventListener('keydown', (event) => { let index = tabs.indexOf(b); if (event.key === 'ArrowRight') index = (index + 1) % tabs.length; else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length; else if (event.key === 'Home') index = 0; else if (event.key === 'End') index = tabs.length - 1; else return; event.preventDefault(); select(tabs[index]); tabs[index].focus(); }); }
  window.addEventListener('beforeunload', (event) => { if (state.dirty.size || state.busy) { event.preventDefault(); event.returnValue = ''; } });
}

export async function refreshOverview() {
  if (!context) return;
  const sequence = ++state.sequence;
  $('overview-refresh').disabled = true; $('overview-view').setAttribute('aria-busy', 'true'); $('overview-error').hidden = true;
  try {
    const query = new URLSearchParams({ q: $('overview-search').value.trim(), caseStatus: $('overview-case-status').value });
    const payload = await context.api('/api/overview?' + query);
    if (sequence !== state.sequence) return;
    state.payload = payload; state.filters = Object.fromEntries(query);
    const scope = document.querySelector('#overview-view .overview-scope');
    scope.textContent = '当前账号的已登记数据 · 已载入' + ({ all: '全部案件（含归档）', active: '进行中案件', archived: '已归档案件' }[state.filters.caseStatus]) + (state.filters.q ? ' · 搜索“' + state.filters.q + '”的匹配案件及其全部节点' : '') + ' · 归档不代表结清';
    renderStats(); renderLedgers(); renderAging(); renderTimeline();
  } catch (error) { if (sequence === state.sequence) errorAt($('overview-error'), error); }
  finally { if (sequence === state.sequence) { $('overview-refresh').disabled = false; $('overview-view').setAttribute('aria-busy', 'false'); } }
}
export function overviewReportText() {
  if (!state.payload.today) return '应收总览尚未成功载入，请刷新后打印。';
  const p = state.payload; const s = p.summary || {};
  const lines = ['应收账款管理平台 · 应收总览', '当前账号的已登记数据 · 归档不代表结清', '统计日期：' + (p.today || '尚未加载'), '案件范围：' + ({ all: '全部（含已归档）', active: '进行中', archived: '已归档' }[state.filters?.caseStatus] || '全部'), '搜索条件：' + (state.filters?.q || '无'), '金额按各节点登记的截至日期汇总；只合计已知有效部分，不代表实时余额。', '', '净开票登记额：' + money(s.invoiceNetAmount), '财务确认应收余额：' + money(s.financeBalance), '已确认节点未收金额：' + money(s.paymentUnpaidAmount), '已到期逾期未收金额：' + money(s.overdueAmount), '未登记有效付款节点案件数：' + (s.recordsWithoutLedgerCount ?? '待加载')];
  for (const l of p.ledgers || []) {
    const d = l.data || {}; const m = l.metrics || {}; const f = d.finance || {}; const due = d.payment || {};
    lines.push('', '【付款节点】' + (d.title || '未命名'), recordName(recordFor(l.recordId)), '节点状态：' + (d.status === 'voided' ? '已作废，不计入统计；' + (d.voidReason || '') : '有效登记') + ' · 版本 ' + l.revision, '开票情况：' + (labels.invoice[d.invoiceStatus] || '待确认') + '；净开票登记额：' + money(m.invoiceNetAmount));
    for (const i of d.invoices || []) lines.push('票据：' + (i.number || '票号待确认') + '；日期：' + date(i.issuedOn) + '；票额：' + money(i.amount) + '；状态：' + ({ issued: '正常开票', red_offset: '红冲', voided: '作废' }[i.status] || '待确认') + '；说明：' + (i.note || '—'));
    lines.push('财务状态：' + (labels.finance[f.status] || '待确认') + '；账面余额：' + money(m.financeBalance) + '；余额截至：' + date(f.asOf), '财务确认日：' + date(f.recognizedOn) + '；账龄起算日：' + date(f.agingStartOn) + '；账龄：' + (m.financeNotRecognized ? '不适用' : m.agingDays === null || m.agingDays === undefined ? '待确认' : m.agingDays + ' 天'), '财务依据：' + (f.reference || '—') + '；财务说明：' + (f.note || '—'), '付款状态：' + (labels.payment[due.status] || '待确认') + '；节点未收金额：' + money(m.paymentUnpaidAmount) + '；金额截至：' + date(due.asOf), '原约定到期：' + date(due.originalDueOn) + '；当前约定到期：' + date(due.currentDueOn) + '；到期情况：' + maturity(m), '付款条件：' + (due.conditions || '—') + '；付款依据：' + (due.basis || '—') + '；付款说明：' + (due.note || '—'), '节点备注：' + (d.note || '—'));
  }
  lines.push('', '【法律时间线】', '内部提醒与人工登记法律期限分别列示；不自动推算诉讼时效。');
  const events = new Map((p.legalEvents || []).map((e) => [e.id, e]));
  for (const entry of p.timeline || []) { const e = events.get(entry.eventId); const d = e?.data || {}; lines.push('', date(entry.date) + ' · ' + (labels.sources[entry.source] || '登记事项') + ' · ' + (entry.title || '—'), recordName(recordFor(entry.recordId)), entry.superseded ? '已被更正 · 原记录保留' : entry.verificationLabel || '待人工核对', entry.description || ''); if (entry.source === 'legal_event') lines.push('实际发生：' + date(d.eventOn) + '；系统登记：' + time(e.createdAt), '送达：' + (labels.delivery[d.deliveryStatus] || '待确认') + '；实际送达日：' + date(d.servedOn), '证据：' + (d.evidenceNote || '—') + '；本案附件引用：' + (d.attachmentIds?.length || 0) + ' 个', '人工核对：' + (d.verification === 'reviewed' ? (d.reviewer || '') + ' · ' + date(d.reviewedOn) : '待核对')); if (entry.source === 'legal_deadline' || entry.source === 'legal_event') lines.push('人工法律期限：' + date(d.deadlineOn || entry.deadlineOn) + '；期限依据：' + (d.deadlineBasis || entry.deadlineBasis || '待填写'), '期限核对：' + (d.deadlineReviewer || entry.deadlineReviewer || '待核对') + ' · ' + date(d.deadlineReviewedOn || entry.deadlineReviewedOn)); if (entry.source === 'note') lines.push('此日期为系统登记时间，不代表事项实际发生日期。'); if (entry.source === 'case_input') lines.push('案件填报日期未核实，不参与法律期限计算。'); }
  return lines.join('\n');
}
function renderStats() {
  const s = state.payload.summary || {}; const target = $('overview-stats'); target.replaceChildren();
  const stats = [
    ['净开票登记额', money(s.invoiceNetAmount), (s.invoiceKnownCount || 0) + ' 个开票情况已确认 · ' + (s.invoiceUnknownCount || 0) + ' 个待确认'],
    ['财务确认应收余额', money(s.financeBalance), (s.financeKnownCount || 0) + ' 个已确认 · ' + (s.financeUnknownCount || 0) + ' 个待确认 · ' + (s.financeNotRecognizedCount || 0) + ' 个未确认为应收'],
    ['已确认节点未收金额', money(s.paymentUnpaidAmount), (s.paymentKnownCount || 0) + ' 个节点已确认 · ' + (s.paymentUnknownCount || 0) + ' 个待确认'],
    ['已到期逾期未收金额', money(s.overdueAmount), (s.overdueCount || 0) + ' 个逾期节点 · 今日到期 ' + (s.dueTodayCount || 0) + ' 个'],
    ['案件登记覆盖', (s.recordCount || 0) + ' 个案件', (s.recordsWithoutLedgerCount || 0) + ' 个案件未登记有效付款节点'],
    ['法律事项待核对', String(s.pendingLegalEventCount || 0) + ' 项', '内部提醒待办 ' + ((s.remindersDueCount || 0) + (s.remindersOverdueCount || 0)) + ' 项 · 人工期限待核 ' + (s.deadlineUnknownCount || 0) + ' 项'],
  ];
  for (const [title, value, detail] of stats) { const card = node('article', 'panel overview-stat'); card.append(node('p', 'overview-stat-label', title), node('strong', 'overview-stat-value', value), node('p', 'overview-stat-detail', detail)); target.append(card); }
  if (s.amountOverflow) target.append(node('p', 'notice warning', '登记金额合计超出可精确计算范围，相关金额显示待确认；请核对明细。'));
}
function renderLedgers() {
  const target = $('overview-ledger-list'); target.replaceChildren();
  const ledgers = state.payload.ledgers || [];
  if (!ledgers.length) target.append(empty('当前范围尚无已登记付款节点。请先保存案件，再分别登记开票、财务应收与付款到期信息。'));
  for (const ledger of ledgers) {
    const d = ledger.data || {}; const m = ledger.metrics || {}; const record = recordFor(ledger.recordId); const archived = record?.status === 'archived';
    const card = node('article', 'panel overview-ledger' + (d.status === 'voided' ? ' is-voided' : ''));
    const heading = node('div', 'overview-ledger-heading'); const identity = node('div'); identity.append(node('p', 'overview-case-ref', recordName(record)), node('h3', '', d.title || '未命名付款节点'));
    const tags = node('div', 'overview-tags'); if (d.status === 'voided') tags.append(node('span', 'status-tag archived', '已作废 · 不计入统计')); if (archived) tags.append(node('span', 'status-tag archived', '案件已归档 · 只读')); tags.append(node('span', 'overview-small', '版本 ' + ledger.revision)); heading.append(identity, tags); card.append(heading);
    const groups = node('div', 'overview-ledger-groups');
    const invoice = node('section'); invoice.append(node('h4', '', '开票记录'), node('p', 'overview-status', labels.invoice[d.invoiceStatus] || '开票待确认')); line(invoice, '净开票登记额', money(m.invoiceNetAmount)); line(invoice, '发票明细', (d.invoices?.length || 0) + ' 条'); invoice.append(node('p', 'overview-small', m.invoiceReason || '票额按已登记有效发票汇总，不等于应收余额。'));
    const finance = node('section'); finance.append(node('h4', '', '财务确认应收'), node('p', 'overview-status', labels.finance[d.finance?.status] || '财务待确认')); line(finance, '财务账面余额', money(m.financeBalance)); line(finance, '余额截至', date(d.finance?.asOf)); line(finance, '账龄起算', date(d.finance?.agingStartOn)); line(finance, '账龄天数', m.financeNotRecognized ? '不适用' : m.agingDays === null || m.agingDays === undefined ? '待确认' : m.agingDays + ' 天'); if (m.agingReason) finance.append(node('p', 'overview-small', m.agingReason)); finance.append(node('p', 'overview-small', m.financeReason || '以本企业财务登记及凭据为准。'));
    const payment = node('section'); payment.append(node('h4', '', '付款到期'), node('p', 'overview-status', labels.payment[d.payment?.status] || '付款节点待确认')); line(payment, '已确认节点未收', money(m.paymentUnpaidAmount)); line(payment, '金额截至', date(d.payment?.asOf)); line(payment, '当前约定到期', date(d.payment?.currentDueOn)); line(payment, '原约定到期', date(d.payment?.originalDueOn)); line(payment, '到期 / 逾期', maturity(m)); payment.append(node('p', 'overview-small', m.paymentReason || '条件未成就或到期日不明时，不显示为零天逾期。'));
    groups.append(invoice, finance, payment); card.append(groups);
    if (d.status === 'voided') card.append(node('p', 'overview-void-reason', '作废原因：' + (d.voidReason || '待补充')));
    const actions = node('div', 'overview-row-actions'); actions.append(btn(archived ? '查看明细' : '查看 / 修改', () => openLedger(ledger)), btn('变更历史', () => showHistory(ledger)), btn('查看案件', () => openCase(ledger.recordId))); const eventButton = btn('记录关联法律事项', () => openEvent(null, ledger.recordId, ledger.id)); eventButton.disabled = archived; actions.append(eventButton, node('span', 'overview-small', '更新于 ' + time(ledger.updatedAt))); card.append(actions); target.append(card);
  }
  const unregistered = $('overview-unregistered'); unregistered.replaceChildren();
  const registered = new Set(ledgers.filter((l) => l.metrics?.included).map((l) => l.recordId)); const records = (state.payload.records || []).filter((r) => !registered.has(r.id));
  if (records.length) { const panel = node('section', 'panel overview-unregistered'); panel.append(node('h3', '', '未登记有效付款节点的案件 · ' + records.length), node('p', 'overview-small', '以下案件没有有效付款节点；案件填写的欠款金额不计入本页应收统计。'));
    for (const r of records) { const row = node('div', 'overview-unregistered-row'); row.append(node('span', '', recordName(r))); const actions = node('div', 'overview-inline-actions'); actions.append(btn('查看案件', () => openCase(r.id))); const b = btn('登记节点', () => openLedger(null, r.id)); b.disabled = r.status === 'archived'; actions.append(b); if (r.status === 'archived') actions.append(node('span', 'status-tag archived', '已归档 · 只读')); row.append(actions); panel.append(row); } unregistered.append(panel); }
}
function maturity(m) { if (m.maturity === 'overdue' && m.overdueDays !== null && m.overdueDays !== undefined) return '逾期 ' + m.overdueDays + ' 天'; if (m.maturity === 'due_today') return '今日到期 · 逾期 0 天'; return labels.maturity[m.maturity] || '到期情况待确认'; }
function renderAging() {
  const target = $('overview-aging'); target.replaceChildren();
  target.append(node('p', 'notice', '账龄反映财务应收存续时间；逾期反映已确认付款节点超过当前约定到期日的时间。两者分别计算。金额只汇总已知且有效的数据，待确认项单列。'));
  const grid = node('div', 'overview-bucket-grid');
  for (const [kind, title, basis] of [['aging', '财务账龄分布', '按财务账龄起算日 · 金额为财务确认余额'], ['overdue', '付款到期与逾期分布', '按当前约定到期日 · 金额为已确认节点未收金额']]) {
    const section = node('section', 'panel'); const h = node('div', 'panel-heading'); h.append(node('h3', '', title)); section.append(h, node('p', 'overview-bucket-help', basis));
    const table = node('table', 'overview-table'); const head = node('thead'); const tr = node('tr'); ['区间', '节点', '已知金额'].forEach((t) => tr.append(node('th', '', t))); head.append(tr); table.append(head); const body = node('tbody');
    for (const b of state.payload.buckets?.[kind] || []) { const row = node('tr'); const cell = node('td', '', money(b.amount)); if (b.amountUnknownCount) cell.append(node('small', '', b.amountUnknownCount + ' 个金额待确认')); row.append(node('td', '', b.label), node('td', '', b.count), cell); body.append(row); } table.append(body); section.append(table); grid.append(section);
  }
  target.append(grid, node('p', 'overview-small', '未确认为财务应收、不适用账龄：' + (state.payload.summary?.agingNotApplicableCount || 0) + ' 个节点。明确未收金额为零的节点不计入到期分桶：' + (state.payload.summary?.noUnpaidCount || 0) + ' 个。'));
  const tablePanel = node('section', 'panel overview-aging-detail'); const h = node('div', 'panel-heading'); h.append(node('h3', '', '节点日期核对')); tablePanel.append(h); const wrap = node('div', 'table-wrap'); const table = node('table', 'overview-table'); const head = node('thead'); const row = node('tr'); ['付款节点 / 案件', '财务账龄', '付款逾期', '操作'].forEach((t) => row.append(node('th', '', t))); head.append(row); table.append(head); const body = node('tbody');
  for (const l of state.payload.ledgers || []) { const m = l.metrics || {}; const tr = node('tr'); const name = node('td'); name.append(node('strong', '', l.data?.title), node('small', '', recordName(recordFor(l.recordId)))); const aging = node('td', '', m.financeNotRecognized ? '不适用' : m.agingDays === null || m.agingDays === undefined ? '账龄待确认' : m.agingDays + ' 天'); aging.append(node('small', '', '起算：' + date(l.data?.finance?.agingStartOn))); const due = node('td', '', maturity(m)); due.append(node('small', '', '当前到期：' + date(l.data?.payment?.currentDueOn))); if (!m.included) name.append(node('small', '', '已作废 · 不计入统计')); const action = node('td'); action.append(btn('查看', () => openLedger(l))); tr.append(name, aging, due, action); body.append(tr); } table.append(body); wrap.append(table); tablePanel.append(wrap); if (!(state.payload.ledgers || []).length) tablePanel.append(node('p', 'overview-empty', '当前范围无付款节点。')); target.append(tablePanel);
}
function renderTimeline() {
  const target = $('overview-timeline'); target.replaceChildren();
  target.append(node('p', 'notice', '法律事项由人工登记并核对。内部提醒与法律期限分开保存；期限需填写依据、核对人和核对日期。系统不按欠款日期自动推算诉讼时效，登记或核对状态均不代表法律结论。'));
  const events = new Map((state.payload.legalEvents || []).map((e) => [e.id, e])); const rows = state.payload.timeline || [];
  if (!rows.length) target.append(empty('当前范围尚无法律事项或案件填报日期。可登记发生日期、送达情况、证据与人工核对信息。'));
  for (const entry of rows) {
    const event = events.get(entry.eventId); const d = event?.data || {}; const article = node('article', 'panel overview-timeline-item' + (entry.superseded ? ' is-superseded' : '')); const dateBlock = node('div', 'overview-timeline-date'); dateBlock.append(node('strong', '', date(entry.date)), node('span', '', labels.sources[entry.source] || '登记事项'));
    const content = node('div', 'overview-timeline-content'); const heading = node('div', 'overview-timeline-heading'); heading.append(node('h3', '', entry.title || '未命名事项')); if (entry.superseded) heading.append(node('span', 'status-tag archived', '已被更正 · 保留原记录')); else heading.append(node('span', 'status-tag', entry.verificationLabel || '待人工核对')); content.append(heading, node('p', 'overview-case-ref', recordName(recordFor(entry.recordId)))); if (entry.description) content.append(node('p', 'overview-timeline-description', entry.description));
    if (entry.source === 'legal_event') {
      const info = node('div', 'overview-timeline-facts'); line(info, '事项类型', labels.types[d.type] || '其他事项'); line(info, '实际发生日期', date(d.eventOn)); line(info, '系统登记时间', time(event?.createdAt)); line(info, '送达情况', labels.delivery[d.deliveryStatus] || '送达情况待确认'); line(info, '实际送达日期', date(d.servedOn)); line(info, '人工核对', d.verification === 'reviewed' ? [d.reviewer, d.reviewedOn].filter(Boolean).join(' · ') : '待核对'); content.append(info);
      const details = node('details', 'overview-event-details'); details.append(node('summary', '', '证据、关联节点与日期依据')); const ledger = (state.payload.ledgers || []).find((l) => l.id === entry.ledgerId); const detailsBody = node('div'); line(detailsBody, '关联付款节点', ledger?.data?.title || '案件级事项'); line(detailsBody, '证据说明', d.evidenceNote || '尚未填写'); line(detailsBody, '本案附件引用', (d.attachmentIds?.length || 0) + ' 个'); line(detailsBody, '内部提醒日期', date(d.reminderOn)); line(detailsBody, '人工法律期限', date(d.deadlineOn)); line(detailsBody, '期限依据', d.deadlineBasis || '尚未填写'); line(detailsBody, '期限核对人 / 日期', [d.deadlineReviewer, d.deadlineReviewedOn].filter(Boolean).join(' · ') || '待核对'); details.append(detailsBody); content.append(details);
    } else if (entry.source === 'legal_deadline') { content.append(node('p', 'overview-small', entry.deadlineLabel || '人工登记期限 · 请核对依据')); line(content, '期限依据', entry.deadlineBasis || '待核对'); line(content, '期限核对', [entry.deadlineReviewer, entry.deadlineReviewedOn].filter(Boolean).join(' · ') || '待核对'); }
    else if (entry.source === 'legal_delivery') content.append(node('p', 'overview-small', '送达日期为人工填报，不自动认定送达效力。'));
    else if (entry.source === 'legal_reminder') content.append(node('p', 'overview-small', '内部跟进提醒，不作为法定期限。'));
    else if (entry.source === 'note') content.append(node('p', 'overview-small', '此日期为跟进记录的系统登记时间，不代表事项实际发生日期。'));
    else if (entry.source === 'case_input') content.append(node('p', 'overview-small', '案件原始填报日期 · 未核实 · 只读参考，不参与法律期限计算。'));
    const actions = node('div', 'overview-inline-actions'); actions.append(btn('查看案件', () => openCase(entry.recordId))); if (event && entry.source === 'legal_event') { const correction = btn(recordFor(entry.recordId)?.status === 'archived' ? '查看事项' : '查看 / 更正', () => openEvent(event)); actions.append(correction); } content.append(actions); article.append(dateBlock, content); target.append(article);
  }
}

function dialog(id, title) {
  let root = $(id); if (!root) { root = node('dialog', 'overview-dialog'); root.id = id; document.body.append(root); state.dialogs.push(root); }
  if (root.open) root.close(); root.dataset.session = String(Number(root.dataset.session || 0) + 1);
  root.replaceChildren(); state.dirty.delete(root); const heading = node('div', 'overview-dialog-heading'); const headingText = node('h2', '', title); headingText.id = id + '-title'; root.setAttribute('aria-labelledby', headingText.id); const close = btn('关闭', () => { if (!state.busy) root.close(); }); heading.append(headingText, close); root.append(heading); const content = node('div', 'overview-dialog-content'); root.append(content);
  root.oncancel = (event) => { if (state.busy) event.preventDefault(); }; root.onclose = () => state.dirty.delete(root); return { root, content, close };
}
function field(parent, name, title, value = '', options = {}) {
  const wrapper = node('div', 'field' + (options.wide ? ' wide' : '')); const label = node('label', '', title); label.htmlFor = name; let control;
  if (options.choices) { control = node('select'); for (const [v, text] of options.choices) { const o = node('option', '', text); o.value = v; control.append(o); } }
  else control = node(options.multiline ? 'textarea' : 'input');
  control.id = name; control.name = name; if (!options.choices && !options.multiline) control.type = options.type || 'text'; if (options.multiline) { control.rows = 2; control.maxLength = options.maxLength || 2000; } else if (!options.choices && control.type === 'text') control.maxLength = options.maxLength || 500;
  if (options.type === 'number') { control.min = '0'; control.max = '999999999999'; control.step = '0.01'; control.inputMode = 'decimal'; }
  if (options.type === 'date') { control.min = '1900-01-01'; control.max = '2199-12-31'; }
  control.value = value ?? ''; control.required = Boolean(options.required); if (options.readonly) control.disabled = true; wrapper.append(label, control); if (options.help) wrapper.append(node('p', 'overview-field-help', options.help)); parent.append(wrapper); return control;
}
function group(parent, title, help) { const section = node('fieldset', 'overview-form-group'); section.append(node('legend', '', title)); if (help) section.append(node('p', 'overview-form-help', help)); const grid = node('div', 'form-grid'); section.append(grid); parent.append(section); return grid; }
function amount(value) { return value === '' ? null : Number(value); }
function formNotice(form) { const notice = node('p', 'form-error'); notice.hidden = true; notice.setAttribute('role', 'alert'); form.append(notice); return notice; }
function watchDraft(form, root) { form.addEventListener('input', () => state.dirty.add(root)); form.addEventListener('change', () => state.dirty.add(root)); }
async function allData(details = false) { if (!details) return context.api('/api/overview/records'); const [payload, selector] = await Promise.all([context.api('/api/overview?caseStatus=all'), context.api('/api/overview/records')]); return { ...payload, records: selector.records || [] }; }
function recordChoices(records) { return [['', '请选择已保存的案件'], ...records.map((r) => [r.id, recordName(r) + (r.status === 'archived' ? '（已归档，只读）' : '')])]; }
function lockForm(form, readonly) { if (readonly) for (const control of form.elements) if (!control.dataset.allowReadonly) control.disabled = true; }
function freeze(form) { const controls = [...form.elements].map((control) => [control, control.disabled]); for (const [control] of controls) control.disabled = true; return () => { for (const [control, disabled] of controls) control.disabled = disabled; }; }

async function openLedger(existing = null, preferredRecord = '') {
  const { root, content } = dialog('overview-ledger-dialog', existing ? '付款节点明细 / 变更' : '登记付款节点'); content.append(node('p', 'overview-form-help', '三类信息分别确认。留空金额表示待确认；0 表示明确登记为零。不会从案件金额、发票日期或其他分组自动补值。'));
  root.showModal(); content.append(node('p', 'overview-small', '正在读取可关联案件…'));
  const session = root.dataset.session; let payload; try { payload = await allData(); } catch (error) { content.replaceChildren(); errorAt(content, error); return; } if (!root.open || root.dataset.session !== session) return; content.querySelector('.overview-small')?.remove();
  const records = payload.records || []; const d = existing?.data || {}; const recordId = existing?.recordId || preferredRecord; const readonly = records.find((r) => r.id === recordId)?.status === 'archived'; const form = node('form', 'overview-editor'); const controls = {};
  const base = group(form, '关联与登记状态', '每个节点属于一个已保存案件；归档案件只读。作废节点保留历史，但不计入统计。');
  controls.record = field(base, 'ov-ledger-record', '关联案件 *', recordId, { choices: recordChoices(records), required: true, wide: true }); controls.record.disabled = Boolean(existing); controls.title = field(base, 'ov-ledger-title', '付款节点名称 *', d.title, { required: true, maxLength: 120 }); controls.status = field(base, 'ov-ledger-status', '节点状态', d.status || 'active', { choices: [['active', '有效登记'], ['voided', '作废（保留历史）']] }); controls.voidReason = field(base, 'ov-ledger-void-reason', '作废原因', d.voidReason, { wide: true, multiline: true });
  const invoiceGroup = group(form, '一 · 开票记录', '开票登记额按有效票据计算。它不自动等于财务应收或付款金额；红冲金额填正数，由系统扣减。'); controls.invoiceStatus = field(invoiceGroup, 'ov-invoice-status', '开票情况', d.invoiceStatus || 'unconfirmed', { choices: Object.entries(labels.invoice), wide: true });
  const invoiceList = node('div', 'overview-invoice-list field wide'); invoiceGroup.append(invoiceList); const invoices = [];
  const addInvoice = (value = {}) => {
    if (invoices.length >= 30) return;
    const item = node('div', 'overview-invoice-row'); const key = 'ov-invoice-' + (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)); const grid = node('div', 'form-grid'); const row = { root: item, id: value.id };
    row.number = field(grid, key + '-number', '发票号码（可待确认）', value.number, { maxLength: 120 }); row.status = field(grid, key + '-status', '票据状态', value.status || 'issued', { choices: [['issued', '正常开票'], ['red_offset', '红冲'], ['voided', '作废']] }); row.issuedOn = field(grid, key + '-date', '开票 / 红冲日期', value.issuedOn, { type: 'date' }); row.amount = field(grid, key + '-amount', '票额（元）', value.amount, { type: 'number' }); row.note = field(grid, key + '-note', '票据说明', value.note, { multiline: true, wide: true, maxLength: 1000 }); const remove = btn('移除此行', () => { invoices.splice(invoices.indexOf(row), 1); item.remove(); state.dirty.add(root); add.disabled = invoices.length >= 30; }); remove.disabled = readonly; item.append(grid, remove); invoices.push(row); invoiceList.append(item); if (readonly) for (const c of item.querySelectorAll('input,select,textarea')) c.disabled = true;
  };
  const add = btn('＋ 添加发票明细', () => { addInvoice(); state.dirty.add(root); add.disabled = invoices.length >= 30; }); invoiceGroup.append(add); for (const i of d.invoices || []) addInvoice(i); add.disabled = invoices.length >= 30;
  const f = d.finance || {}; const financeGroup = group(form, '二 · 财务确认应收', '填写本企业财务确认的账面余额及凭据。账龄起算日需单独确认，不从开票日推定。'); controls.financeStatus = field(financeGroup, 'ov-finance-status', '财务确认状态', f.status || 'unconfirmed', { choices: Object.entries(labels.finance) }); controls.financeBalance = field(financeGroup, 'ov-finance-balance', '财务账面余额（元）', f.balance, { type: 'number' }); controls.recognizedOn = field(financeGroup, 'ov-finance-recognized', '财务确认日期', f.recognizedOn, { type: 'date' }); controls.agingStartOn = field(financeGroup, 'ov-finance-aging', '财务账龄起算日', f.agingStartOn, { type: 'date', help: '留空显示账龄待确认；不会使用开票日期替代。' }); controls.financeAsOf = field(financeGroup, 'ov-finance-asof', '余额截至日期', f.asOf, { type: 'date' }); controls.reference = field(financeGroup, 'ov-finance-reference', '财务确认凭据 / 依据', f.reference, { help: '确认状态须填写凭据，例如对账单、凭证编号及核对说明。' }); controls.financeNote = field(financeGroup, 'ov-finance-note', '财务说明', f.note, { multiline: true, wide: true });
  const p = d.payment || {}; const paymentGroup = group(form, '三 · 付款到期', '原约定与当前约定日期分开留存。附条件付款应填写条件；未核实到期日或条件未成就时，逾期显示待确认。'); controls.paymentStatus = field(paymentGroup, 'ov-payment-status', '付款节点确认状态', p.status || 'unconfirmed', { choices: Object.entries(labels.payment) }); controls.unpaidAmount = field(paymentGroup, 'ov-payment-unpaid', '本节点未收金额（元）', p.unpaidAmount, { type: 'number' }); controls.paymentAsOf = field(paymentGroup, 'ov-payment-asof', '节点未收金额截至日期', p.asOf, { type: 'date' }); controls.originalDueOn = field(paymentGroup, 'ov-payment-original-due', '原约定到期日', p.originalDueOn, { type: 'date' }); controls.currentDueOn = field(paymentGroup, 'ov-payment-current-due', '当前约定到期日', p.currentDueOn, { type: 'date', help: '调整日期须在变更原因说明依据，历史版本保留此前日期。' }); controls.conditions = field(paymentGroup, 'ov-payment-conditions', '付款条件 / 待成就事项', p.conditions, { multiline: true }); controls.basis = field(paymentGroup, 'ov-payment-basis', '付款约定依据', p.basis, { multiline: true, wide: true, help: '确认状态须填写依据，例如合同条款、补充协议或付款承诺。' }); controls.paymentNote = field(paymentGroup, 'ov-payment-note', '付款说明', p.note, { multiline: true, wide: true });
  const extra = group(form, '备注与变更留痕'); controls.note = field(extra, 'ov-ledger-note', '节点备注', d.note, { multiline: true, wide: true, maxLength: 4000 }); if (existing) controls.changeReason = field(extra, 'ov-ledger-change-reason', '本次变更原因 *', '', { required: true, multiline: true, wide: true, help: '说明修改金额、日期、状态及依据的原因。旧版本继续保留。' });
  const notice = formNotice(form); const footer = node('div', 'overview-dialog-footer'); const cancel = btn(readonly ? '关闭' : '取消', () => { if (!state.busy) root.close(); }); cancel.dataset.allowReadonly = 'true'; const save = node('button', 'button primary', existing ? '保存新版本' : '保存付款节点'); save.type = 'submit'; footer.append(node('span', 'overview-small', readonly ? '归档案件只读；如需修改，请先在案件工作台恢复。' : '手工登记至当前账号 · 不调用分析服务'), cancel); if (!readonly) footer.append(save); form.append(footer); content.append(form); lockForm(form, readonly); watchDraft(form, root);
  function requiredFields() { controls.financeBalance.required = controls.recognizedOn.required = controls.financeAsOf.required = controls.financeStatus.value === 'confirmed'; controls.unpaidAmount.required = controls.paymentAsOf.required = controls.originalDueOn.required = controls.currentDueOn.required = controls.paymentStatus.value === 'confirmed'; controls.voidReason.required = controls.status.value === 'voided'; controls.reference.required = controls.financeStatus.value === 'confirmed'; controls.basis.required = controls.paymentStatus.value === 'confirmed'; for (const i of invoices) { i.issuedOn.required = ['issued', 'red_offset'].includes(i.status.value); i.amount.required = i.issuedOn.required; } }
  form.addEventListener('change', requiredFields); requiredFields();
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (state.busy || readonly) return; requiredFields(); notice.hidden = true;
    if (!form.reportValidity()) return; const selectedRecord = records.find((r) => r.id === controls.record.value); if (!selectedRecord || selectedRecord.status !== 'active') { errorAt(notice, new Error('请选择已保存且进行中的案件。')); return; }
    const data = { title: controls.title.value.trim(), status: controls.status.value, voidReason: controls.voidReason.value.trim(), currency: 'CNY', invoiceStatus: controls.invoiceStatus.value, invoices: invoices.map((i) => ({ ...(i.id ? { id: i.id } : {}), number: i.number.value.trim(), issuedOn: i.issuedOn.value, amount: amount(i.amount.value), status: i.status.value, note: i.note.value.trim() })), finance: { status: controls.financeStatus.value, recognizedOn: controls.recognizedOn.value, agingStartOn: controls.agingStartOn.value, balance: amount(controls.financeBalance.value), asOf: controls.financeAsOf.value, reference: controls.reference.value.trim(), note: controls.financeNote.value.trim() }, payment: { status: controls.paymentStatus.value, unpaidAmount: amount(controls.unpaidAmount.value), asOf: controls.paymentAsOf.value, originalDueOn: controls.originalDueOn.value, currentDueOn: controls.currentDueOn.value, conditions: controls.conditions.value.trim(), basis: controls.basis.value.trim(), note: controls.paymentNote.value.trim() }, note: controls.note.value.trim() };
    if (data.invoiceStatus === 'recorded' && !data.invoices.some((i) => ['issued', 'red_offset'].includes(i.status))) { errorAt(notice, new Error('已登记发票须至少填写一条正常开票或红冲明细。')); return; }
    if (data.invoiceStatus === 'not_issued' && data.invoices.some((i) => ['issued', 'red_offset'].includes(i.status))) { errorAt(notice, new Error('“未开票”不能同时保留正常开票或红冲明细；已全部红冲的票据请保留“已登记发票”，原记录不会自动删除。')); return; }
    state.busy = true; const thaw = freeze(form); save.disabled = true;
    try { await context.api(existing ? '/api/overview/ledgers/' + encodeURIComponent(existing.id) : '/api/overview/ledgers', { method: existing ? 'PATCH' : 'POST', body: existing ? { revision: existing.revision, data, changeReason: controls.changeReason.value.trim() } : { recordId: selectedRecord.id, data } }); state.dirty.delete(root); root.close(); await refreshOverview(); }
    catch (error) { errorAt(notice, error); }
    finally { state.busy = false; thaw(); save.disabled = false; }
  });
}

async function showHistory(ledger) {
  const { root, content } = dialog('overview-history-dialog', '付款节点变更历史'); root.showModal(); content.append(node('p', 'overview-small', '正在读取历史版本…'));
  const session = root.dataset.session;
  try { const payload = await context.api('/api/overview/ledgers/' + encodeURIComponent(ledger.id) + '/history'); if (!root.open || root.dataset.session !== session) return; content.replaceChildren(); const history = [...(payload.history || [])].sort((a, b) => b.revision - a.revision); if (!history.length) content.append(empty('尚无历史版本。'));
    for (const item of history) { const details = node('details', 'overview-history-version'); const d = item.data || {}; details.open = item === history[0]; details.append(node('summary', '', '版本 ' + item.revision + ' · ' + time(item.createdAt))); details.append(node('p', 'overview-history-reason', '变更原因：' + (item.changeReason || '首次登记'))); const rows = node('div', 'overview-history-data'); line(rows, '节点名称 / 状态', (d.title || '—') + ' · ' + (d.status === 'voided' ? '已作废' : '有效登记')); if (d.voidReason) line(rows, '作废原因', d.voidReason); line(rows, '开票状态', labels.invoice[d.invoiceStatus] || '待确认'); for (const i of d.invoices || []) line(rows, '发票 ' + (i.number || '票号待确认'), date(i.issuedOn) + ' · ' + money(i.amount) + ' · ' + ({ issued: '正常开票', red_offset: '红冲', voided: '作废' }[i.status] || '待确认') + (i.note ? ' · ' + i.note : '')); line(rows, '财务确认状态', labels.finance[d.finance?.status] || '待确认'); line(rows, '财务余额 / 截至', money(d.finance?.balance) + ' · ' + date(d.finance?.asOf)); line(rows, '财务确认日 / 账龄起算', date(d.finance?.recognizedOn) + ' · ' + date(d.finance?.agingStartOn)); line(rows, '财务依据', d.finance?.reference || '—'); line(rows, '财务说明', d.finance?.note || '—'); line(rows, '付款状态', labels.payment[d.payment?.status] || '待确认'); line(rows, '未付金额 / 截至', money(d.payment?.unpaidAmount) + ' · ' + date(d.payment?.asOf)); line(rows, '原约定到期 / 当前到期', date(d.payment?.originalDueOn) + ' · ' + date(d.payment?.currentDueOn)); line(rows, '付款条件', d.payment?.conditions || '—'); line(rows, '付款依据', d.payment?.basis || '—'); line(rows, '付款说明', d.payment?.note || '—'); line(rows, '节点备注', d.note || '—'); details.append(rows); content.append(details); }
  } catch (error) { content.replaceChildren(); errorAt(content, error); }
}

async function openEvent(existing = null, preferredRecord = '', preferredLedger = '') {
  const { root, content } = dialog('overview-event-dialog', existing ? '法律事项详情 / 更正' : '记录法律事项'); root.showModal(); content.append(node('p', 'overview-small', '正在读取可关联案件…'));
  const session = root.dataset.session; let payload; try { payload = await allData(true); } catch (error) { content.replaceChildren(); errorAt(content, error); return; } if (!root.open || root.dataset.session !== session) return; content.replaceChildren();
  const records = payload.records || []; const ledgers = payload.ledgers || []; const recordId = existing?.recordId || preferredRecord; const d = existing?.data || {}; const archived = records.find((r) => r.id === recordId)?.status === 'archived'; const superseded = existing && (payload.legalEvents || []).some((e) => e.supersedesId === existing.id); const readonly = archived || superseded;
  content.append(node('p', 'overview-form-help', existing ? '更正会新增一条关联事项；原记录保留并标注“已被更正”。请在事项说明中填写本次更正原因。' : '按实际材料登记发生日期、送达与核对情况。系统登记时间由平台保存，不等于实际发生日期。'));
  const form = node('form', 'overview-editor'); const base = group(form, '事项与关联'); const record = field(base, 'ov-event-record', '关联案件 *', recordId, { choices: recordChoices(records), required: true, wide: true }); record.disabled = Boolean(existing); const ledger = field(base, 'ov-event-ledger', '关联付款节点（可选）', '', { choices: [['', '案件级事项']], wide: true }); const type = field(base, 'ov-event-type', '事项类型', d.type || 'other', { choices: Object.entries(labels.types) }); const eventOn = field(base, 'ov-event-on', '实际发生日期', d.eventOn, { type: 'date', help: '日期不明确时留空并保持待核对，不使用系统登记时间替代。' }); const title = field(base, 'ov-event-title', '事项标题 *', d.title, { required: true, maxLength: 120, wide: true }); const description = field(base, 'ov-event-description', '事项说明', d.description, { multiline: true, wide: true, maxLength: 4000 });
  const delivery = group(form, '送达与证据', '送达日期须按实际凭证登记；仅登记发出日期不代表已经送达。附件仅能引用所选案件已有资料，也可先填写证据说明。'); const deliveryStatus = field(delivery, 'ov-event-delivery-status', '送达情况', d.deliveryStatus || 'unknown', { choices: Object.entries(labels.delivery) }); const servedOn = field(delivery, 'ov-event-served-on', '实际送达日期', d.servedOn, { type: 'date' }); const evidenceNote = field(delivery, 'ov-event-evidence', '证据位置 / 说明', d.evidenceNote, { multiline: true, wide: true, maxLength: 4000 }); const attachments = node('fieldset', 'field wide overview-attachment-picker'); attachments.append(node('legend', '', '引用本案附件（可选）')); const attachmentList = node('div', 'overview-attachment-options'); attachments.append(attachmentList); delivery.append(attachments);
  const review = group(form, '事项人工核对'); const verification = field(review, 'ov-event-verification', '核对状态', d.verification || 'pending', { choices: [['pending', '待人工核对'], ['reviewed', '已人工核对登记']] }); const reviewer = field(review, 'ov-event-reviewer', '核对人', d.reviewer, { maxLength: 120 }); const reviewedOn = field(review, 'ov-event-reviewed-on', '核对日期', d.reviewedOn, { type: 'date' });
  const dates = group(form, '内部提醒与人工法律期限', '内部提醒用于跟进。法律期限仅按人工确认的具体依据登记，必须同时填写期限依据、核对人及核对日期；不自动推算。'); const reminderOn = field(dates, 'ov-event-reminder', '内部跟进提醒日期', d.reminderOn, { type: 'date' }); const deadlineOn = field(dates, 'ov-event-deadline', '人工确认法律期限（可选）', d.deadlineOn, { type: 'date' }); const deadlineBasis = field(dates, 'ov-event-deadline-basis', '期限依据与计算说明', d.deadlineBasis, { multiline: true, wide: true, help: '例如具体文书、送达情况、适用条款与人工计算过程。' }); const deadlineReviewer = field(dates, 'ov-event-deadline-reviewer', '期限核对人', d.deadlineReviewer, { maxLength: 120 }); const deadlineReviewedOn = field(dates, 'ov-event-deadline-reviewed-on', '期限核对日期', d.deadlineReviewedOn, { type: 'date' });
  const notice = formNotice(form); const footer = node('div', 'overview-dialog-footer'); const close = btn(readonly ? '关闭' : '取消', () => { if (!state.busy) root.close(); }); close.dataset.allowReadonly = 'true'; const save = node('button', 'button primary', existing ? '保存更正事项' : '保存法律事项'); save.type = 'submit'; footer.append(node('span', 'overview-small', archived ? '归档案件只读。' : superseded ? '此事项已有更正记录，请查阅最新事项。' : '人工登记 · 原记录留存'), close); if (!readonly) footer.append(save); form.append(footer); content.append(form); lockForm(form, readonly); watchDraft(form, root);
  let attachmentSequence = 0; let availableAttachments = []; const selectedIds = new Set(d.attachmentIds || []);
  function unavailableReferences(available = new Set(), failed = false) { let index = 0; for (const id of selectedIds) { if (available.has(id)) continue; const label = node('label'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.value = id; checkbox.checked = true; checkbox.disabled = readonly; label.append(checkbox, node('span', '', '历史附件引用 ' + (++index) + (failed ? '（列表暂不可读；可取消引用后保存）' : '（原文件已不可用；取消引用后可更正）'))); attachmentList.append(label); } }
  async function updateAssociations(initial = false) {
    const sequence = ++attachmentSequence; const id = record.value; ledger.replaceChildren(); const option = node('option', '', '案件级事项'); option.value = ''; ledger.append(option); for (const item of ledgers.filter((l) => l.recordId === id)) { const o = node('option', '', (item.data?.title || '付款节点') + (item.data?.status === 'voided' ? '（已作废）' : '')); o.value = item.id; ledger.append(o); } ledger.value = initial ? existing?.ledgerId || preferredLedger : ''; attachmentList.replaceChildren(); availableAttachments = []; if (!initial) selectedIds.clear();
    const selectedRecord = records.find((r) => r.id === id); if (!id) { attachmentList.append(node('p', 'overview-small', '先选择案件，再选择本案已有附件。')); return; } if (!existing) { save.disabled = selectedRecord?.status !== 'active'; } attachmentList.append(node('p', 'overview-small', '正在读取本案附件…'));
    try { const response = await context.api('/api/records/' + encodeURIComponent(id)); if (sequence !== attachmentSequence || !root.open) return; availableAttachments = response.record?.attachments || []; attachmentList.replaceChildren(); if (!availableAttachments.length) attachmentList.append(node('p', 'overview-small', '本案尚无可用附件，可填写证据说明。')); for (const item of availableAttachments) { const label = node('label'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.value = item.id; checkbox.checked = selectedIds.has(item.id); checkbox.disabled = readonly; label.append(checkbox, node('span', '', item.name || '未命名附件')); attachmentList.append(label); } unavailableReferences(new Set(availableAttachments.map((item) => item.id))); }
    catch (error) { if (sequence !== attachmentSequence) return; attachmentList.replaceChildren(); errorAt(attachmentList, new Error('附件暂不可读：' + error.message + '。可填写证据说明。')); unavailableReferences(new Set(), true); }
  }
  record.addEventListener('change', () => { updateAssociations(); }); await updateAssociations(true);
  function requirements() { eventOn.required = evidenceNote.required = reviewer.required = reviewedOn.required = verification.value === 'reviewed'; deadlineBasis.required = deadlineReviewer.required = deadlineReviewedOn.required = Boolean(deadlineOn.value); servedOn.required = deliveryStatus.value === 'served'; }
  form.addEventListener('change', requirements); requirements();
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (readonly || state.busy) return; requirements(); notice.hidden = true; if (!form.reportValidity()) return; const selectedRecord = records.find((r) => r.id === record.value); if (!selectedRecord || selectedRecord.status !== 'active') { errorAt(notice, new Error('请选择已保存且进行中的案件。')); return; }
    const checkedIds = new Set([...attachmentList.querySelectorAll('input:checked')].map((i) => i.value));
    const data = { type: type.value, eventOn: eventOn.value, title: title.value.trim(), description: description.value.trim(), deliveryStatus: deliveryStatus.value, servedOn: servedOn.value, evidenceNote: evidenceNote.value.trim(), attachmentIds: [...checkedIds], verification: verification.value, reviewer: reviewer.value.trim(), reviewedOn: reviewedOn.value, reminderOn: reminderOn.value, deadlineOn: deadlineOn.value, deadlineBasis: deadlineBasis.value.trim(), deadlineReviewer: deadlineReviewer.value.trim(), deadlineReviewedOn: deadlineReviewedOn.value };
    state.busy = true; const thaw = freeze(form); save.disabled = true;
    try { await context.api('/api/overview/legal-events', { method: 'POST', body: { recordId: record.value, ledgerId: ledger.value || null, supersedesId: existing?.id || null, data } }); state.dirty.delete(root); root.close(); await refreshOverview(); }
    catch (error) { errorAt(notice, error); }
    finally { state.busy = false; thaw(); save.disabled = false; }
  });
}

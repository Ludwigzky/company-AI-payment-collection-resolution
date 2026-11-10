import { generatePlan } from './engine.js';
import { SOURCES } from './sources.js';

const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z"/><path d="M12 5v15"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.5 5.5L8 16l2.5-5.5L16 8Z"/>',
  tool: '<path d="M14 5a5 5 0 0 0-6 6l-5 5a2.8 2.8 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-3-3 3-3Z"/>',
  briefcase: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V4h8v3M3 12l9 3 9-3M12 12v5"/>',
  building: '<path d="M4 21V7h8v14M12 3h8v18M2 21h20M7 10h2M7 14h2M7 18h2M15 7h2M15 11h2M15 15h2"/>',
  rotate: '<path d="M3 10a9 9 0 1 1 1 7M3 4v6h6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4M18 4h4"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  printer: '<path d="M7 8V3h10v5M7 17H3v-9h18v9h-4M7 14h10v7H7zM17 11h1"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  circle: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3h.01"/>',
  scales: '<path d="M12 3v18M5 21h14M4 7h16M5 7l-3 7h6L5 7Zm14 0-3 7h6l-3-7Z"/>',
  message: '<path d="M21 11a9 9 0 0 1-9 9 10 10 0 0 1-4-1l-5 2 1-5a9 9 0 1 1 17-5Z"/><path d="M8 10h8M8 14h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
};

function icon(name) {
  const span = document.createElement('span');
  // Only fixed SVG paths are inserted as markup; case input is always textContent.
  span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || paths.circle) + '</svg>';
  return span;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
document.querySelectorAll('[data-icon]').forEach((node) => node.replaceChildren(icon(node.dataset.icon)));
const form = document.querySelector('#case-form');
const sourceMap = new Map(SOURCES.map((source) => [source.id, source]));
const tracks = { repair: { label: '维修与履约', icon: 'tool' }, business: { label: '商务与财务', icon: 'briefcase' }, legal: { label: '法务与争议解决', icon: 'scales' }, complaint: { label: '投诉与主管渠道', icon: 'message' } };
let currentPlan;
let isSample = true;
let toastTimer;

function chinaToday() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function shiftedDate(days) {
  const date = new Date(chinaToday() + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function getInput() {
  const data = new FormData(form);
  const input = Object.fromEntries(data.entries());
  input.amount = Number(data.get('amount'));
  input.issueTypes = data.getAll('issueTypes');
  input.evidence = data.getAll('evidence');
  return input;
}
function toast(message) {
  const node = document.querySelector('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
}
function showView(view) {
  document.querySelectorAll('.view').forEach((node) => { node.hidden = node.id !== view + '-view'; });
  document.querySelectorAll('[data-view]').forEach((node) => {
    node.classList.toggle('active', node.dataset.view === view);
    if (node.dataset.view === view) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  document.querySelector('#page-title').textContent = { workspace: '方案工作台', sources: '法律与官方渠道', guide: '使用指南' }[view];
  document.querySelector('#mobile-nav').value = view;
  window.scrollTo({ top: 0, behavior: 'instant' });
}
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelector('#mobile-nav').addEventListener('change', (event) => showView(event.target.value));
document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); showView('workspace'); });
document.querySelector('#guide-start').addEventListener('click', () => showView('workspace'));

function selectTab(tab) {
  document.querySelectorAll('.report-tab').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.report-content').forEach((node) => { node.hidden = node.id !== 'report-' + tab; });
}
document.querySelectorAll('.report-tab').forEach((button) => {
  button.addEventListener('click', () => selectTab(button.dataset.tab));
  button.addEventListener('keydown', (event) => {
    const tabs = [...document.querySelectorAll('.report-tab')];
    const index = tabs.indexOf(button);
    const target = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : undefined;
    if (target) { event.preventDefault(); selectTab(target.dataset.tab); target.focus(); }
  });
});

function sourceLink(source, label) {
  const a = element('a', '', label || source.title);
  a.href = source.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = source.title + ' · ' + source.locator;
  return a;
}
function renderOverview(plan, input) {
  const card = element('article', 'overview-card');
  const top = element('div', 'overview-top');
  const badge = element('span', 'priority-tag ' + plan.priority.tone, plan.priority.label);
  badge.title = plan.priority.reason;
  top.append(element('span', 'eyebrow', '本次建议 · 按项目问题分流'), badge);
  const beforeDue = input.dueDate > plan.generatedAt;
  const blocked = plan.actions.some((action) => action.track === 'repair' && action.priority === '优先');
  card.append(top, element('h3', '', beforeDue ? '先确认履约节点，提前落实付款安排' : blocked ? '先厘清项目争议，同步推动款项支付' : '从书面对账开始，分步推进回款'), element('p', 'strategy-text', plan.strategy));
  const metrics = element('div', 'metric-row');
  for (const item of [
    { label: '待核对欠款', value: '¥' + plan.amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) },
    { label: '按填报到期日计算', value: beforeDue ? '尚未到期' : plan.overdueDays === 0 ? '今日到期' : String(plan.overdueDays), unit: beforeDue || plan.overdueDays === 0 ? '' : '天', compact: beforeDue || plan.overdueDays === 0 },
    { label: '建议协同', value: blocked ? '售后 + 财务 + 法务' : '商务 + 财务 + 法务', compact: true },
  ]) {
    const metric = element('div');
    const value = element('strong', 'metric-value' + (item.compact ? ' compact' : ''), item.value);
    if (item.unit) value.append(element('small', '', item.unit));
    metric.append(element('span', 'metric-label', item.label), value);
    metrics.append(metric);
  }
  card.append(metrics);
  document.querySelector('#report-overview').replaceChildren(card);
}
function renderActions(plan) {
  const grid = element('div', 'action-grid');
  for (const action of plan.actions) {
    const track = tracks[action.track];
    const card = element('article', 'action-card');
    const header = element('div', 'action-header');
    const symbol = element('span', 'track-icon ' + action.track); symbol.append(icon(track.icon));
    const title = element('div'); title.append(element('div', 'action-kicker', track.label), element('h3', '', action.title));
    header.append(symbol, title, element('span', 'action-priority', action.priority));
    const list = element('ol');
    action.steps.forEach((step) => list.append(element('li', '', step)));
    const meta = element('div', 'action-meta'); meta.append(element('span', '', '负责人：' + action.owner));
    const details = element('details'); details.append(element('summary', '', '查看适用条件与材料'), element('p', '', '适用条件：' + action.condition), element('p', '', '推进时间：' + action.timing), element('p', '', '所需材料：' + action.materials.join('、')));
    const links = element('div', 'source-links');
    action.sourceIds.forEach((id) => { const source = sourceMap.get(id); if (source) links.append(sourceLink(source)); });
    card.append(header, element('p', 'action-reason', action.reason), list, meta, details, links);
    grid.append(card);
  }
  const timelinePanel = element('article', 'panel timeline-panel');
  const caption = element('h3', 'section-caption', '建议推进顺序'); caption.prepend(icon('clock'));
  const timeline = element('div', 'timeline');
  for (const stage of plan.timeline) {
    const node = element('div', 'timeline-stage');
    const list = element('ul'); stage.items.forEach((item) => list.append(element('li', '', item)));
    node.append(element('span', '', '阶段 ' + stage.phase), element('h4', '', stage.title), list); timeline.append(node);
  }
  timelinePanel.append(caption, timeline);
  document.querySelector('#report-actions').replaceChildren(grid, timelinePanel);
}
function renderEvidence(plan) {
  const gaps = element('article', 'panel evidence-card');
  gaps.append(element('h3', '', '建议补充与确认')); const gapList = element('ul', 'gap-list');
  plan.missingInfo.forEach((gap) => gapList.append(element('li', '', gap)));
  if (!plan.missingInfo.length) gapList.append(element('li', '', '输入项已补充，仍需核查实际材料的内容与证明力。'));
  gaps.append(gapList);
  const evidence = element('article', 'panel evidence-card'); evidence.append(element('h3', '', '材料准备清单'));
  for (const item of plan.evidenceChecklist) {
    const row = element('div', 'evidence-row' + (item.present ? ' present' : '')); const copy = element('div');
    copy.append(element('strong', '', item.label), element('p', '', item.reason));
    row.append(icon(item.present ? 'check' : 'circle'), copy, element('span', 'evidence-status', item.present ? '用户称已持有' : '待准备 / 核实')); evidence.append(row);
  }
  const facts = element('article', 'panel evidence-card'); facts.append(element('h3', '', '本次输入的事实记录'));
  for (const fact of plan.facts) { const row = element('div', 'evidence-row'); const copy = element('div'); copy.append(element('strong', '', fact.label), element('p', '', fact.value)); row.append(copy); facts.append(row); }
  const caution = element('article', 'panel caution-list'); caution.append(element('h3', '', '核查提醒')); const list = element('ul'); plan.caution.forEach((item) => list.append(element('li', '', item))); caution.append(list);
  document.querySelector('#report-evidence').replaceChildren(gaps, evidence, facts, caution);
  document.querySelector('#gap-count').textContent = plan.missingInfo.length;
}
function renderLetter(plan) {
  const panel = element('article', 'panel letter-panel'); const top = element('div', 'letter-top');
  const button = element('button', 'button secondary small', '复制草稿'); button.type = 'button'; button.prepend(icon('copy'));
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(plan.letterDraft); toast('沟通函草稿已复制，请核查后使用'); }
    catch { toast('浏览器未允许复制，可选中下方草稿复制'); }
  });
  top.append(element('h3', '', '回款与项目事项沟通函'), button);
  panel.append(top, element('p', 'letter-help', '这是业务沟通草稿。请补齐双方名称、联系人及回复日期，核对事实后使用；系统不会自动发送。'), element('pre', 'letter-text', plan.letterDraft));
  document.querySelector('#report-letter').replaceChildren(panel);
}
function renderSources() {
  const catalog = document.querySelector('#source-catalog');
  for (const source of SOURCES) {
    const card = element('article', 'panel source-card');
    card.append(element('span', 'source-kind', source.kind === 'law' ? '法律法规 · 官方全文' : '官方渠道 · 办事与受理条件'), element('h2', '', source.title), element('p', 'source-meta', source.issuer), element('p', '', '适用提示摘要：' + source.summary));
    if (source.articles.length) card.append(element('p', '', '条号定位：' + source.articles.join('、')));
    card.append(element('p', 'source-meta', source.locator), element('p', 'source-meta', source.versionNote), element('p', 'source-meta', '最近资料核查：' + source.verifiedAt));
    const link = sourceLink(source, source.kind === 'law' ? '查看官方原文' : '前往官方入口'); link.append(icon('external')); card.append(link);
    if (source.authorityUrl) { const authority = sourceLink({ ...source, url: source.authorityUrl }, '核查官方办事说明'); authority.style.marginLeft = '16px'; card.append(authority); }
    if (source.rulesUrl) { const rules = sourceLink({ ...source, url: source.rulesUrl }, '核查受理规则'); rules.style.marginLeft = '16px'; card.append(rules); }
    catalog.append(card);
  }
}
function renderPlan(input) {
  const plan = generatePlan(input, chinaToday());
  currentPlan = plan;
  renderOverview(plan, input); renderActions(plan); renderEvidence(plan); renderLetter(plan);
  document.querySelector('#report-status').textContent = (isSample ? '虚构示例方案' : '方案已更新') + ' · ' + plan.generatedAt;
  document.querySelector('#dirty-notice').hidden = true;
  document.querySelector('#form-error').hidden = true;
  selectTab('actions');
}
const samples = {
  equipment: { amount: 328000, dueDate: () => shiftedDate(-90), issueText: '设备已交付，客户反馈运行不稳定，以维修和验收未完成为由暂缓支付尾款。双方尚未确认故障原因和费用承担，希望推动售后处理并争取先收回无争议部分。', issueTypes: ['repair', 'acceptance'], evidence: ['contract', 'delivery', 'invoice'], acceptanceStatus: 'disputed' },
  general: { amount: 186000, dueDate: () => shiftedDate(-60), issueText: '我方为中小企业，货物已交付且完成验收。对方为大型企业，反馈资金安排紧张，希望延后付款。尚未取得书面付款计划，拟先对账并核查适用投诉渠道。以上均为虚构示例。', issueTypes: ['cashflow'], evidence: ['contract', 'delivery', 'acceptance', 'invoice', 'reconciliation'], acceptanceStatus: 'passed', debtorType: 'large', creditorSize: 'sme', disputeAccepted: 'no', disputeClause: 'court' },
  construction: { amount: 760000, dueDate: () => shiftedDate(-180), issueText: '项目已交付使用，但结算审核尚未完成，双方对部分工程量存在争议。客户以结算未完成为由暂缓付款，需要先核查合同付款节点、项目记录和无争议金额。以上均为虚构示例。', issueTypes: ['acceptance', 'dispute'], evidence: ['contract', 'delivery', 'collection'], acceptanceStatus: 'pending' },
};
function loadSample(kind) {
  form.reset();
  const sample = samples[kind];
  form.elements.projectType.value = kind;
  for (const [key, value] of Object.entries(sample)) {
    if (Array.isArray(value)) form.querySelectorAll(`input[name="${key}"]`).forEach((node) => { node.checked = value.includes(node.value); });
    else form.elements[key].value = typeof value === 'function' ? value() : value;
  }
  document.querySelectorAll('[data-scenario]').forEach((button) => button.classList.toggle('active', button.dataset.scenario === kind));
  document.querySelector('#sample-label').textContent = '当前为虚构示例，可直接修改'; isSample = true;
  renderPlan(getInput());
}
document.querySelectorAll('[data-scenario]').forEach((button) => button.addEventListener('click', () => { loadSample(button.dataset.scenario); toast('已载入虚构示例'); }));
form.addEventListener('input', () => {
  isSample = false; document.querySelector('#sample-label').textContent = '正在编辑输入';
  document.querySelector('#dirty-notice').textContent = '输入已修改，请点击“生成回款方案”更新右侧结果。';
  document.querySelector('#dirty-notice').hidden = false;
});
form.addEventListener('change', () => { isSample = false; document.querySelector('#dirty-notice').textContent = '输入已修改，请点击“生成回款方案”更新右侧结果。'; document.querySelector('#dirty-notice').hidden = false; });
form.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    renderPlan(getInput()); toast('回款方案已更新');
    if (window.innerWidth <= 720) document.querySelector('#result-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    const node = document.querySelector('#form-error'); node.textContent = error.message; node.hidden = false;
  }
});
document.querySelector('#reset-button').addEventListener('click', () => {
  form.reset(); form.elements.amount.value = ''; form.elements.dueDate.value = ''; form.elements.issueText.value = ''; isSample = false;
  document.querySelector('#sample-label').textContent = '请填写新的案件信息';
  document.querySelector('#dirty-notice').textContent = '表单已清空。右侧暂时保留上次方案，请填写后重新生成。';
  document.querySelector('#dirty-notice').hidden = false;
  document.querySelector('#form-error').hidden = true;
  document.querySelectorAll('[data-scenario]').forEach((button) => button.classList.remove('active'));
  form.elements.amount.focus();
});
function reportText() {
  const p = currentPlan;
  const lines = ['企业回款推进方案（演示草稿）', '分析日期：' + p.generatedAt, '', '【输入与判断】', ...p.facts.map((fact) => fact.label + '：' + fact.value), '', '【整体建议】', p.summary, p.strategy, '内部推进优先级：' + p.priority.label, p.priority.reason];
  for (const action of p.actions) {
    lines.push('', '【' + tracks[action.track].label + '】' + action.title, '负责人：' + action.owner, '安排：' + action.timing, '原因：' + action.reason, ...action.steps.map((step, index) => (index + 1) + '. ' + step), '条件：' + action.condition, '材料：' + action.materials.join('、'));
    action.sourceIds.forEach((id) => { const source = sourceMap.get(id); if (source) lines.push('官方依据 / 渠道：' + source.title + '\n' + source.url + '\n定位：' + (source.articles.join('、') || source.locator) + '\n资料核查日期：' + source.verifiedAt); });
  }
  lines.push('', '【建议推进顺序】', ...p.timeline.flatMap((stage) => [stage.phase + ' ' + stage.title, ...stage.items.map((item) => '- ' + item)]), '', '【待补充与确认】', ...p.missingInfo.map((item) => '- ' + item), '', '【材料清单】', ...p.evidenceChecklist.map((item) => (item.present ? '[用户称已持有] ' : '[待准备] ') + item.label + '：' + item.reason), '', '【沟通函草稿】', p.letterDraft, '', '【核查提醒】', ...p.caution.map((item) => '- ' + item), '', '当前为规则演示，未接入大模型、企业合同或实时法律检索。');
  return lines.join('\n');
}
document.querySelector('#export-button').addEventListener('click', () => {
  const blob = new Blob(['\uFEFF' + reportText()], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = element('a');
  a.href = url; a.download = '回款推进方案-' + currentPlan.generatedAt + '.txt'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('已导出当前生成的文本方案');
});
document.querySelector('#print-button').addEventListener('click', () => { document.querySelector('#print-report').textContent = reportText(); window.print(); });
window.addEventListener('beforeprint', () => { if (currentPlan) document.querySelector('#print-report').textContent = reportText(); });
renderSources();
loadSample('equipment');
selectTab('actions');

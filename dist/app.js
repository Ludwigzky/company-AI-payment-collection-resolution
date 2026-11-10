import { generatePlan } from './engine.js';
import { SOURCES } from './sources.js';
import { initOverview, refreshOverview, overviewReportText } from './overview.js';
import { initProvider } from './provider.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const form = $('#case-form');
const trackNames = { repair: '维修与履约', business: '商务与财务', legal: '法务与争议解决', complaint: '投诉与主管渠道' };
const cache = new Map();
const selections = new Map();
const selectedRuns = new Map();
const noteDrafts = new Map();
const running = new Map();
const runErrors = new Map();
const runOperationNotices = new Map();
let deleteRunTarget = null;
let runOperationBusy = false;
let active = null;
let summaries = [];
let dirty = false;
let editVersion = 0;
let draftKey = 0;
let caseTab = 'info';
let reportTab = 'actions';
let filterStatus = 'all';
let writeQueue = Promise.resolve();
let pendingWrites = 0;
let navigating = false;
let conflicted = false;
let listSequence = 0;
let readSequence = 0;
let listController;
let readController;
let searchTimer;
let toastTimer;
let service = {};
let draftMode = 'supplement';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function list(items, ordered = false) {
  const node = el(ordered ? 'ol' : 'ul');
  (items || []).forEach((item) => node.append(el('li', '', item)));
  return node;
}
function button(label, className = 'button secondary small') {
  const node = el('button', className, label); node.type = 'button'; return node;
}
function money(value) {
  return value === '' || value === null || value === undefined ? '金额待填写' : '¥ ' + Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function dateTime(value, short = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', ...(short ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
function chinaDateOffset(days = 0) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function bytes(size) {
  if (!size) return '0 B';
  return size >= 1048576 ? (size / 1048576).toFixed(2) + ' MB' : Math.ceil(size / 1024) + ' KB';
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4300);
}
function clearError() { $('#workspace-error').hidden = true; $('#form-error').hidden = true; }
function showError(error, recordId = active?.id) {
  const message = error?.message || '操作未完成，请稍后重试。';
  if (recordId && active?.id !== recordId) { toast(message); return; }
  $('#workspace-error').textContent = message; $('#workspace-error').hidden = false;
  if (error?.status === 409) { conflicted = true; $('#conflict-notice').hidden = false; }
  renderHeader();
}
async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, credentials: 'same-origin', headers, body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('服务器返回内容无法读取，请重试。'); }
  if (!response.ok) {
    const error = new Error(payload?.error || '操作未完成，请稍后重试。'); error.status = response.status; throw error;
  }
  return payload;
}
function queueWrite(task) {
  pendingWrites += 1; renderControls();
  const result = writeQueue.then(task);
  writeQueue = result.catch(() => {});
  return result.finally(() => { pendingWrites -= 1; renderControls(); });
}
function getInput() {
  const data = new FormData(form);
  const input = Object.fromEntries(data.entries());
  delete input.title;
  input.amount = data.get('amount') === '' ? '' : Number(data.get('amount'));
  input.issueTypes = data.getAll('issueTypes'); input.evidence = data.getAll('evidence');
  return input;
}
function fillForm(record) {
  form.reset();
  const input = record?.input || {};
  for (const control of form.elements) {
    if (!control.name || control.name === 'title') continue;
    if (control.type === 'checkbox') control.checked = Array.isArray(input[control.name]) && input[control.name].includes(control.value);
    else if (Object.hasOwn(input, control.name)) control.value = input[control.name] ?? '';
  }
  form.elements.title.value = record?.title || '';
}
function mergedItems(previous = [], received = []) {
  return [...new Map([...previous, ...received].map((item) => [item.id, item])).values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
function activeRuns(record = active) { return (record?.runs || []).filter((run) => !run.deletedAt); }
function runOrdinal(record, run) { return (record?.runs || []).length - (record?.runs || []).findIndex((item) => item.id === run.id); }
function mergedRuns(previous = [], received = []) {
  const merged = new Map(previous.map((run) => [run.id, run]));
  for (const run of received) {
    const prior = merged.get(run.id);
    // Visibility changes are independent of the case's input revision. A late
    // analysis snapshot must not undo a later deletion or restoration.
    const preferred = prior && Number(prior.stateVersion || 0) > Number(run.stateVersion || 0) ? prior : run;
    const other = preferred === prior ? run : prior;
    merged.set(run.id, { ...other, ...preferred, plan: preferred.plan ?? other?.plan });
  }
  return [...merged.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)));
}
function acceptRecord(record) {
  if (!record?.id) throw new Error('记录响应不完整，请重新载入。');
  const previous = cache.get(record.id);
  // Late analysis responses must never replace more recent input or attachments.
  const previousIsNewer = previous && (previous.revision > record.revision || (previous.revision === record.revision && String(previous.updatedAt) > String(record.updatedAt)));
  const merged = previousIsNewer ? { ...previous } : { ...record };
  merged.runs = mergedRuns(previous?.runs, record.runs);
  merged.notes = mergedItems(previous?.notes, record.notes);
  merged.attachments ||= [];
  cache.set(record.id, merged);
  if (!selections.has(record.id)) selections.set(record.id, new Set(merged.attachments.map((item) => item.id)));
  const summary = { id: merged.id, number: merged.number, title: merged.title, status: merged.status, revision: merged.revision, debtorName: merged.input?.debtorName, amount: merged.input?.amount, dueDate: merged.input?.dueDate, attachmentCount: merged.attachments.length, runCount: activeRuns(merged).length, updatedAt: merged.updatedAt };
  summaries = [summary, ...summaries.filter((item) => item.id !== record.id)].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (active?.id === merged.id) active = merged;
  renderHistory();
  return merged;
}
async function saveDraftNow({ force = false } = {}) {
  if (conflicted) { const error = new Error('记录版本已冲突。请先保留填写内容，再重新载入服务器版本。'); error.status = 409; throw error; }
  if (active && !dirty) return active;
  if (!active && !dirty && !force) return null;
  // The queue serializes revision-dependent writes. Editing can continue while saving.
  do {
    const version = editVersion;
    const context = draftKey;
    const priorId = active?.id;
    const title = form.elements.title.value.trim() || '未命名回款案件';
    const input = getInput();
    $('#save-state').textContent = '正在保存至服务器…';
    const payload = priorId
      ? await api('/api/records/' + encodeURIComponent(priorId), { method: 'PATCH', body: { revision: active.revision, title, input } })
      : await api('/api/records', { method: 'POST', body: { title, input } });
    if (context !== draftKey || (priorId && active?.id !== priorId)) throw new Error('当前记录已切换，请重新载入后核对。');
    const saved = acceptRecord(payload.record);
    if (!priorId) {
      active = saved;
      if (noteDrafts.has('draft')) { noteDrafts.set(saved.id, noteDrafts.get('draft')); noteDrafts.delete('draft'); }
    }
    dirty = version !== editVersion;
    if (!dirty && !form.elements.title.value.trim()) form.elements.title.value = saved.title;
    renderCurrent();
  } while (dirty);
  return active;
}
function saveDraft(options) { return queueWrite(() => saveDraftNow(options)); }
function showView(view) {
  $$('.view').forEach((node) => { node.hidden = node.id !== view + '-view'; });
  $$('[data-view]').forEach((node) => { node.classList.toggle('active', node.dataset.view === view); if (node.dataset.view === view) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
  if (view === 'overview') void refreshOverview();
}
function selectCaseTab(tab) {
  caseTab = tab;
  $$('[data-case-tab]').forEach((node) => { const selected = node.dataset.caseTab === tab; node.classList.toggle('active', selected); node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1; });
  $('#details-layout').hidden = !['info', 'materials'].includes(tab);
  $('#details-layout').classList.toggle('materials-only', tab === 'materials');
  $('#form-panel').hidden = tab === 'materials';
  $('#plan-section').hidden = tab !== 'plan'; $('#notes-section').hidden = tab !== 'notes';
}
function selectReportTab(tab) {
  reportTab = tab;
  $$('[data-report-tab]').forEach((node) => { const selected = node.dataset.reportTab === tab; node.classList.toggle('active', selected); node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1; });
  $$('.report-content').forEach((node) => { node.hidden = node.id !== 'report-' + tab; });
}
function tabKeyboard(nodes, onSelect) {
  nodes.forEach((node, index) => node.addEventListener('keydown', (event) => {
    const target = event.key === 'ArrowRight' ? nodes[(index + 1) % nodes.length] : event.key === 'ArrowLeft' ? nodes[(index + nodes.length - 1) % nodes.length] : event.key === 'Home' ? nodes[0] : event.key === 'End' ? nodes.at(-1) : null;
    if (target) { event.preventDefault(); onSelect(target); target.focus(); }
  }));
}
function renderControls() {
  const archived = active?.status === 'archived';
  const busy = pendingWrites > 0 || navigating;
  $('#save-button').disabled = busy || archived || conflicted;
  $('#save-button').textContent = pendingWrites ? '保存中…' : '保存';
  $('#generate-button').disabled = busy || archived || conflicted || running.has(active?.id);
  $('#generate-button').textContent = running.has(active?.id) ? '方案生成中…' : '生成回款方案';
  $('#archive-button').disabled = !active || busy || conflicted;
  $('#archive-button').textContent = archived ? '恢复案件' : '归档';
  $('#choose-files').disabled = busy || archived || conflicted; $('#choose-images').disabled = busy || archived || conflicted;
  $('#add-note').disabled = busy || archived || conflicted;
  $('#new-record').disabled = navigating; $('#create-sample').disabled = navigating;
  $('#reload-record').disabled = navigating || pendingWrites > 0;
  $$('[data-case-tab]').forEach((node) => { node.disabled = navigating; });
  $$('.history-item').forEach((node) => { node.disabled = navigating; });
  $$('.remove-file').forEach((node) => { node.disabled = busy || archived || conflicted; });
  const runBusy = busy || runOperationBusy || running.has(active?.id);
  $('#delete-run').disabled = !currentRun() || runBusy || archived || conflicted;
  $('#delete-run').title = archived ? '恢复案件后操作' : '';
  $('#run-select').disabled = !activeRuns().length || busy || runOperationBusy;
  $$('.restore-run').forEach((node) => { node.disabled = runBusy || archived || conflicted; node.title = archived ? '恢复案件后操作' : ''; });
  $('#confirm-delete-run').disabled = runOperationBusy || busy || !deleteRunTarget;
  $('#cancel-delete-run').disabled = runOperationBusy;
  form.inert = navigating || archived;
}
function renderHeader() {
  $('#case-number').textContent = active ? active.number + ' · 资料版本 ' + active.revision : '新建记录 · 尚未保存';
  $('#case-title').textContent = form.elements.title.value.trim() || active?.title || '未命名回款案件';
  const status = active?.status === 'archived' ? '已归档' : active ? '进行中' : '草稿';
  $('#case-status').textContent = status; $('#case-status').className = 'status-tag' + (active?.status === 'archived' ? ' archived' : active ? '' : ' draft');
  $('#save-state').classList.toggle('unsaved', dirty);
  $('#save-state').textContent = conflicted ? '版本冲突 · 当前填写内容已保留' : dirty ? '有未保存修改 · 切换案件前自动保存' : active ? '已保存 · 最近更新 ' + dateTime(active.updatedAt) : '填写后保存，资料与方案将归档至本记录';
  $('#attachment-count').textContent = active?.attachments?.length || 0; $('#run-count').textContent = activeRuns().length; $('#note-count').textContent = active?.notes?.length || 0;
  renderControls();
}
function renderHistory() {
  const query = $('#history-search').value.trim().toLowerCase();
  const visible = summaries.filter((item) => (filterStatus === 'all' || item.status === filterStatus) && (!query || [item.title, item.debtorName, item.number].join(' ').toLowerCase().includes(query)));
  $('#history-count').textContent = '共 ' + visible.length + ' 条记录';
  const container = $('#history-list'); container.replaceChildren();
  if (!visible.length) {
    const empty = el('div', 'history-empty'); empty.append(el('strong', '', query || filterStatus !== 'all' ? '没有符合条件的记录' : '暂无案件记录'), el('p', '', '点击“新建记录”开始填写')); container.append(empty); return;
  }
  for (const item of visible) {
    const node = button('', 'history-item' + (active?.id === item.id ? ' active' : ''));
    node.dataset.recordId = item.id;
    if (active?.id === item.id) node.setAttribute('aria-current', 'true');
    const top = el('div', 'history-item-top');
    top.append(el('strong', '', item.title || '未命名回款案件'));
    if (item.status === 'archived') top.append(el('span', 'status-tag archived', '已归档'));
    else if (running.has(item.id)) top.append(el('span', 'status-tag', '生成中'));
    const bottom = el('div', 'history-item-bottom'); bottom.append(el('span', 'history-amount', money(item.amount)), el('span', '', dateTime(item.updatedAt, true)));
    node.append(top, el('div', 'history-item-customer', item.debtorName || '客户名称待填写'), bottom);
    node.addEventListener('click', () => navigate(item.id)); container.append(node);
  }
  renderControls();
}
async function loadHistory({ initial = false } = {}) {
  const sequence = ++listSequence;
  listController?.abort(); listController = new AbortController();
  $('#history-count').textContent = '正在读取记录…';
  try {
    const query = new URLSearchParams({ q: $('#history-search').value.trim(), status: filterStatus });
    const payload = await api('/api/records?' + query, { signal: listController.signal });
    if (sequence !== listSequence) return;
    summaries = (Array.isArray(payload.records) ? payload.records : []).map((summary) => {
      const known = cache.get(summary.id);
      if (!known || known.revision < summary.revision || (known.revision === summary.revision && String(known.updatedAt) < String(summary.updatedAt))) return summary;
      return { ...summary, title: known.title, status: known.status, revision: known.revision, debtorName: known.input?.debtorName, amount: known.input?.amount, dueDate: known.input?.dueDate, attachmentCount: known.attachments.length, runCount: activeRuns(known).length, updatedAt: known.updatedAt };
    }); renderHistory();
    if (initial && summaries.length && !active && !dirty && !navigating) await navigate(summaries[0].id);
  } catch (error) {
    if (error.name === 'AbortError' || sequence !== listSequence) return;
    $('#history-count').textContent = '读取失败';
    if (!summaries.length) { const node = el('div', 'history-empty'); node.append(el('strong', '', '无法读取案件记录'), el('p', '', error.message)); $('#history-list').replaceChildren(node); }
    toast('案件列表读取失败：' + error.message);
  }
}
async function navigate(id = null, sample = false, reload = false) {
  if (navigating || (id && id === active?.id && !reload)) { showView('workspace'); return; }
  closeDeleteRunDialog();
  navigating = true; renderControls();
  const previousId = active?.id;
  noteDrafts.set(previousId || 'draft', $('#note-body').value);
  try {
    if (!reload) await saveDraft();
    else await writeQueue;
    let next = null;
    if (id) {
      const sequence = ++readSequence; readController?.abort(); readController = new AbortController();
      const payload = await api('/api/records/' + encodeURIComponent(id), { signal: readController.signal });
      if (sequence !== readSequence) return;
      // Explicit reload takes the server version, including its complete attachments.
      if (reload) cache.delete(id);
      next = acceptRecord(payload.record);
    }
    active = next; draftKey += 1; dirty = false; editVersion += 1; conflicted = false;
    $('#conflict-notice').hidden = true; clearError(); fillForm(next);
    $('#note-body').value = noteDrafts.get(next?.id || 'draft') || '';
    if (!next) { $('#note-body').value = ''; noteDrafts.delete('draft'); }
    if (sample) {
      fillForm({ title: '示例：华东设备项目尾款', input: { amount: 328000, dueDate: chinaDateOffset(-90), companyName: '示例设备公司', debtorName: '示例采购公司', issueText: '【虚构示例】设备已交付，客户反馈运行不稳定，以维修和验收未完成为由暂缓支付尾款。尚未确认故障原因及费用承担，拟先推动售后核查，同时对账并争取无争议部分付款。', projectType: 'equipment', issueTypes: ['repair', 'acceptance'], evidence: ['contract', 'delivery', 'invoice'], acceptanceStatus: 'disputed', debtorType: 'enterprise', creditorSize: 'unknown', disputeClause: 'unknown', disputeAccepted: 'unknown' } });
      dirty = true; await saveDraft({ force: true }); toast('已新建虚构示例记录，可继续上传资料');
    }
    showView('workspace'); selectCaseTab('info'); renderCurrent(); renderHistory();
  } catch (error) { if (error.name !== 'AbortError') showError(error, active?.id); }
  finally { navigating = false; renderControls(); if (!active && !sample) form.elements.title.focus(); }
}
function attachmentUrl(recordId, attachmentId) { return '/api/records/' + encodeURIComponent(recordId) + '/attachments/' + encodeURIComponent(attachmentId) + '/content'; }
function selectedIds(record = active) {
  if (!record) return [];
  const selected = selections.get(record.id) || new Set();
  return record.attachments.filter((item) => selected.has(item.id)).map((item) => item.id);
}
function renderAttachments() {
  const attachments = active?.attachments || [];
  const total = attachments.reduce((sum, item) => sum + Number(item.size || 0), 0);
  $('#materials-size').textContent = attachments.length + ' / 8 个文件 · ' + bytes(total);
  const target = $('#attachment-list'); target.replaceChildren();
  if (!attachments.length) { const row = el('tr'); const cell = el('td', 'attachment-empty', '暂无资料。上传后将保存在当前案件记录中。'); cell.colSpan = 3; row.append(cell); target.append(row); }
  const recordId = active?.id;
  for (const attachment of attachments) {
    const row = el('tr'); const choice = el('td', 'select-col'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = selections.get(recordId)?.has(attachment.id); checkbox.setAttribute('aria-label', '将 ' + attachment.name + ' 纳入本次分析');
    checkbox.addEventListener('change', () => {
      const set = selections.get(recordId); if (!set) return;
      if (checkbox.checked) set.add(attachment.id); else set.delete(attachment.id);
      if (active?.id === recordId) { renderSelectedMaterials(); renderPlanState(); }
    }); choice.append(checkbox);
    const info = el('td'); info.append(el('span', 'file-name', attachment.name), el('div', 'file-meta', bytes(attachment.size) + ' · ' + dateTime(attachment.createdAt)));
    const actions = el('td'); const actionsInner = el('div', 'file-actions');
    const preview = button('预览', ''); preview.addEventListener('click', () => previewAttachment(recordId, attachment));
    const download = el('a', '', '下载'); download.href = attachmentUrl(recordId, attachment.id); download.download = attachment.name;
    const remove = button('移除', 'remove-file'); remove.addEventListener('click', () => removeAttachment(recordId, attachment));
    actionsInner.append(preview, download, remove); actions.append(actionsInner); row.append(choice, info, actions); target.append(row);
  }
  renderSelectedMaterials();
}
function renderSelectedMaterials() {
  const attachments = active?.attachments || [];
  const ids = new Set(selectedIds()); const selected = attachments.filter((item) => ids.has(item.id));
  $('#selected-materials').textContent = attachments.length ? '本次选中 ' + selected.length + ' / ' + attachments.length + ' 个材料（' + bytes(selected.reduce((sum, item) => sum + item.size, 0)) + '）' + (selected.length < attachments.length ? '；未选中材料不会发送给分析服务。' : '，均纳入下次分析。') : '尚未上传材料；也可仅按填报信息生成方案。';
}
async function uploadFiles(files) {
  const batch = [...files]; if (!batch.length || navigating) return;
  if (active?.status === 'archived') { toast('请先恢复案件再上传资料'); return; }
  const extensions = /\.(pdf|docx|xlsx|txt|csv|md|json|png|jpe?g|gif|webp)$/i;
  const invalid = batch.find((file) => !extensions.test(file.name) || file.size > 5 * 1048576 || !file.size);
  if (invalid) { showError(new Error('“' + invalid.name + '”格式不支持、内容为空或超过单文件 5 MB 限额。')); return; }
  const origin = active?.id;
  try {
    await queueWrite(async () => {
      const record = await saveDraftNow({ force: true });
      const recordId = record.id;
      if (origin && origin !== recordId) throw new Error('请在原案件中重新选择上传。');
      if (record.attachments.length + batch.length > 8 || record.attachments.reduce((sum, item) => sum + item.size, 0) + batch.reduce((sum, item) => sum + item.size, 0) > 16 * 1048576) throw new Error('每个案件最多 8 个文件，资料总量不超过 16 MB。');
      let uploaded = 0;
      try {
        for (const file of batch) {
          const body = new FormData(); body.append('file', file);
          const payload = await api('/api/records/' + encodeURIComponent(recordId) + '/attachments', { method: 'POST', body });
          acceptRecord(payload.record); selections.get(recordId)?.add(payload.attachment.id); uploaded += 1;
          // Only the captured record may receive this upload in the visible workspace.
          if (active?.id === recordId) renderCurrent();
        }
      } catch (error) { if (uploaded) error.message = '已上传 ' + uploaded + ' 个文件，其余未完成：' + error.message; throw error; }
      toast('已上传 ' + uploaded + ' 个材料，归入 ' + record.number);
    });
  } catch (error) { showError(error, origin || active?.id); }
}
async function removeAttachment(recordId, attachment) {
  try {
    await queueWrite(async () => {
      if (active?.id !== recordId) return;
      await saveDraftNow();
      const payload = await api('/api/records/' + encodeURIComponent(recordId) + '/attachments/' + encodeURIComponent(attachment.id), { method: 'DELETE' });
      acceptRecord(payload.record); selections.get(recordId)?.delete(attachment.id);
      if (active?.id === recordId) renderCurrent();
      toast('已从当前资料中移除，历史方案仍保留当时的材料记录');
    });
  } catch (error) { showError(error, recordId); }
}
function previewAttachment(recordId, attachment) {
  $('#preview-title').textContent = attachment.name; const content = $('#preview-content'); content.replaceChildren();
  if (/^image\/(png|jpeg|gif|webp)$/.test(attachment.mime)) {
    const image = el('img'); image.src = attachmentUrl(recordId, attachment.id); image.alt = attachment.name;
    image.addEventListener('error', () => { content.replaceChildren(el('p', '', '图片无法预览，请下载原文件核对。')); }); content.append(image);
  } else {
    content.append(el('p', '', attachment.mime === 'application/pdf' ? '请下载 PDF 后使用本机阅读器查看，核对原始资料及页码。' : '此类文件请下载后使用对应应用查看。'));
    const link = el('a', 'button secondary', '下载原文件'); link.href = attachmentUrl(recordId, attachment.id); link.download = attachment.name; content.append(link);
  }
  $('#preview-dialog').showModal();
}
function currentRun() {
  const runs = activeRuns();
  return runs.find((run) => run.id === selectedRuns.get(active?.id)) || runs[0] || null;
}
function aiFor(plan) { return plan?.generation?.mode === 'ai' ? plan.ai : null; }
const legalStatusNames = { conditional: '条件性建议', insufficient: '信息不足', not_applicable: '本案暂不适用' };
const legacyLegalNotice = '本版本未保存逐条法律核验，请重新生成';
function legalReviewFor(plan) {
  const review = plan?.legalReview;
  return review && typeof review === 'object' && !Array.isArray(review) ? review : null;
}
function legalFindingsFor(plan, action) { return (legalReviewFor(plan)?.findings || []).filter((finding) => finding.actionId === action.id); }
function legalRecommendationFindings(review, recommendation) {
  const basis = recommendation.basisIds || recommendation.groundingIds || []; const ids = Array.isArray(basis) ? [...new Set(basis)] : [];
  const findings = (review?.findings || []).filter((finding) => ids.includes(finding.id) && finding.track === recommendation.track && finding.status !== 'not_applicable');
  return ids.length && findings.length === ids.length ? findings : [];
}
function legalReviewTasks(findings) { return [...new Set(findings.flatMap((finding) => finding.missingEvidence || []))]; }
function legalStatusName(finding) { return finding.statusLabel || legalStatusNames[finding.status] || '待核实'; }
function legalStatusTag(finding) { return el('span', 'legal-status ' + (Object.hasOwn(legalStatusNames, finding.status) ? finding.status : ''), legalStatusName(finding)); }
function adviceKind(action, review) { return ['repair', 'business'].includes(action.track) || (review?.businessActionIds || []).includes(action.id) ? '业务建议' : '法律建议'; }
function factText(value) {
  if (value === undefined || value === null || value === '') return '未填报';
  if (Array.isArray(value)) return value.length ? value.map(factText).join('、') : '未填报';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function factOrigin(fact) { return fact.source === 'material_inventory' ? '附件清单 · 未核实；不证明材料内容与真实性' : '用户填报 · 未核实'; }
function factValueText(fact) {
  const choices = {
    projectType: { equipment: '设备销售 / 安装维保', general: '一般企业应收账款', construction: '工程项目结算' },
    debtorType: { enterprise: '一般企业 / 规模待核实', large: '大型企业', government: '机关', institution: '事业单位' },
    creditorSize: { unknown: '尚未确认', sme: '中小企业', large: '大型企业' },
    acceptanceStatus: { unknown: '尚未确认', passed: '填报已验收，待核验', pending: '尚待验收 / 结算', disputed: '存在验收 / 结算异议' },
    disputeClause: { unknown: '尚未确认', court: '法院诉讼约定，待核验', arbitration: '仲裁约定，待核验' },
    disputeAccepted: { unknown: '尚未确认', no: '填报尚未受理或处理', yes: '填报已有受理或处理' },
    issueTypes: { repair: '设备维修', acceptance: '验收未完成', invoice: '开票 / 对账', cashflow: '资金紧张', dispute: '金额 / 质量争议', unresponsive: '失联 / 拒绝沟通' },
  };
  const labels = choices[fact.field];
  if (labels) return Array.isArray(fact.value) ? fact.value.map((value) => labels[value] || value).join('、') || '未填报' : labels[fact.value] || factText(fact.value);
  if (fact.source === 'material_inventory' && fact.value && typeof fact.value === 'object') return factText(fact.value.name) + '；' + factText(fact.value.method) + '；仅为本次材料清单';
  return factText(fact.value);
}
function reviewDateLabel(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : dateTime(value); }
function corpusVerificationDates(review) { return [...new Set((review.findings || []).flatMap((finding) => (finding.citations || []).map((citation) => citation.verifiedAt)).filter(Boolean))].join('、'); }
function legalFindingTarget(id) { return 'legal-finding-' + encodeURIComponent(String(id)); }
function openLegalFinding(id) {
  selectReportTab('legal');
  const target = id ? document.getElementById(legalFindingTarget(id)) : $('#report-legal');
  if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
}
function legalDetailButton(finding, label = '查看法律依据') {
  const node = button(label, 'text-button legal-detail-link'); node.addEventListener('click', () => openLegalFinding(finding?.id)); return node;
}
function officialClauseLink(citation) {
  try {
    const url = new URL(citation.officialUrl);
    if (url.protocol !== 'https:' || url.username || url.password || !(url.hostname === 'gov.cn' || url.hostname.endsWith('.gov.cn'))) return null;
    const link = el('a', '', '查看官方全文'); link.href = citation.officialUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
  } catch { return null; }
}
function legalMetadata(entries, className = 'legal-metadata') {
  const metadata = el('dl', className);
  for (const [label, value] of entries) { const row = el('div'); row.append(el('dt', '', label), el('dd', '', factText(value))); metadata.append(row); }
  return metadata;
}
function citationEntries(citation) {
  const statuses = { current: '现行版本，具体时间适用另核', repealed: '已失效版本', superseded: '已被替代的版本' };
  const temporalStatuses = { verification_required: '版本信息待核验', not_yet_effective_at_review: '核对日尚未施行', outside_version_at_review: '核对日不在该版本效力期间', provisional_current_procedure: '当前程序规则线索，实际启动日期待核', historical_scope_unconfirmed: '历史事实的时间适用尚未确认', reported_dates_within_version: '填报日期在所载版本期间，仍待核验', historical_version_required: '需补检历史版本及衔接规则', reported_date_invalid: '填报日期无效', reported_date_in_future: '填报日期尚未发生' };
  return [['条文编号', citation.id], ['法律编号', citation.lawId], ['版本', [citation.versionLabel, citation.versionId].filter(Boolean).join(' · ')], ['公布日期', citation.promulgatedAt], ['施行日期', citation.effectiveFrom], ['失效日期', citation.effectiveTo || '未记载'], ['条文状态', statuses[citation.status] || citation.status], ['时点适用', [temporalStatuses[citation.temporalStatus] || citation.temporalStatus, citation.temporalNote].filter(Boolean).join(' · ')], ['发布机关', citation.issuer], ['原文定位', citation.locator], ['来源类型', citation.sourceKind === 'official-fulltext' ? '官方全文' : citation.sourceKind], ['资料核查日期', citation.verifiedAt]];
}
function renderLegalSummary(plan) {
  const review = legalReviewFor(plan); const panel = el('article', 'panel legal-summary'); const copy = el('div');
  copy.append(el('h3', '', '法律适用核对'));
  if (!review) copy.append(el('p', '', legacyLegalNotice));
  else {
    const findings = review.findings || []; const parts = Object.entries(legalStatusNames).map(([status, label]) => [label, findings.filter((finding) => finding.status === status).length]).filter(([, count]) => count);
    copy.append(el('p', '', parts.length ? parts.map(([label, count]) => label + ' ' + count + ' 项').join(' · ') : '本版本尚无适用核对项'));
    const dates = corpusVerificationDates(review);
    copy.append(el('small', '', '已核验法条库 · 按案件检索；' + (dates ? '法条核验日期 ' + dates + '；' : '') + '非实时全库查询。填报事实未核实。'));
  }
  panel.append(copy, legalDetailButton(null, review ? '查看核对与条文' : '查看版本说明')); $('#report-legal-summary').replaceChildren(panel);
}
function renderClause(citation) {
  const details = el('details', 'legal-clause'); const summary = el('summary');
  summary.append(el('strong', '', (citation.lawTitle || '法律条文') + ' ' + (citation.article || '')), el('span', '', '展开条文全文与版本信息')); details.append(summary);
  details.append(el('p', 'clause-text', citation.text || '本版本未保存条文全文。'), legalMetadata(citationEntries(citation), 'legal-metadata clause-metadata'));
  const source = el('div', 'clause-source'); const link = officialClauseLink(citation);
  if (link) source.append(link); else source.append(el('span', '', '本版本未提供可跳转的官方全文地址'));
  if (citation.officialUrl) source.append(el('span', 'official-url', citation.officialUrl));
  details.append(source); return details;
}
function renderLegal(plan) {
  const target = $('#report-legal'); target.replaceChildren(); const review = legalReviewFor(plan);
  if (!review) { const panel = el('article', 'panel legal-panel'); panel.append(el('h3', '', '历史版本说明'), el('p', '', legacyLegalNotice), el('p', 'legal-muted', '当前展示所选版本原有内容；重新生成后将另存一个包含逐条法律核对的新版本。')); target.append(panel); return; }
  const overview = el('article', 'panel legal-panel'); overview.append(el('h3', '', '法律适用核对'), el('p', 'legal-scope-label', '已核验法条库 · 按案件检索 · 非实时全库查询'), el('p', '', review.coverageNote || '根据所选版本的填报信息与附件清单进行法律适用条件核对。'), legalMetadata([['适用地区', review.jurisdiction], ['核对日期', reviewDateLabel(review.reviewedAt)], ['法条核验日期', corpusVerificationDates(review) || '见条文记录'], ['条文库版本', review.corpusVersion], ['核对格式版本', review.schemaVersion]]), el('p', 'legal-muted', '以下核对随本次方案保存。用户填报及附件清单均未核实；附件存在、文字提取或图片识别不代表事实已获证明。条文核对不等于律师审核或责任认定。'));
  if (review.limitations?.length) { overview.append(el('h4', '', '核对范围与限制'), list(review.limitations)); }
  target.append(overview);
  const facts = el('article', 'panel legal-panel'); facts.append(el('h3', '', '核对所用事实 · 均未核实')); const wrap = el('div', 'table-wrap'); const table = el('table', 'legal-facts-table'); const head = el('thead'); const heading = el('tr');
  ['事实编号', '填报项与当时值', '来源及核实状态'].forEach((label) => heading.append(el('th', '', label))); head.append(heading); table.append(head); const body = el('tbody');
  for (const fact of review.facts || []) { const row = el('tr'); const value = el('td'); value.append(el('strong', '', fact.label), el('p', '', factValueText(fact))); row.append(el('td', 'fact-id', fact.id), value, el('td', '', factOrigin(fact))); body.append(row); }
  table.append(body); wrap.append(table); facts.append(wrap); target.append(facts);
  const factMap = new Map((review.facts || []).map((fact) => [fact.id, fact]));
  for (const finding of review.findings || []) {
    const card = el('article', 'panel legal-panel legal-finding'); card.id = legalFindingTarget(finding.id); const header = el('div', 'legal-finding-heading'); const title = el('div'); title.append(el('div', 'action-kicker', [finding.id, trackNames[finding.track] || finding.track].filter(Boolean).join(' · ')), el('h3', '', finding.title)); header.append(title, legalStatusTag(finding)); card.append(header, el('p', 'legal-advice', finding.advice));
    card.append(el('h4', '', '为什么关联本案'), el('p', '', factText(finding.whyApplicable)));
    if (finding.factIds?.length) { card.append(el('h4', '', '关联填报事实')); const items = finding.factIds.map((id) => { const fact = factMap.get(id); return fact ? id + ' · ' + fact.label + '：' + factValueText(fact) + '（' + factOrigin(fact) + '）' : id + ' · 本版本未保存对应事实'; }); card.append(list(items)); }
    for (const [label, items] of [['仍需满足的条件', finding.conditions], ['待补充或核实的证据', finding.missingEvidence], ['适用提醒', finding.cautions]]) if (items?.length) card.append(el('h4', '', label), list(items));
    card.append(el('h4', '', '关联条文 · 本版本原文'));
    if (finding.citations?.length) finding.citations.forEach((citation) => card.append(renderClause(citation))); else card.append(el('p', 'legal-muted', '本核对项未保存关联条文，不据此确认具体法律权利。'));
    target.append(card);
  }
  const retrieval = el('details', 'panel legal-panel retrieval-panel'); retrieval.append(el('summary', '', '检索问题与命中记录'), el('p', 'legal-muted', '检索方式：' + factText(review.retrieval?.description || review.retrieval?.method)));
  for (const query of review.retrieval?.queries || []) { const row = el('div', 'retrieval-row'); row.append(el('strong', '', (query.id ? query.id + ' · ' : '') + query.question), el('p', '', '命中条文：' + (query.clauseIds?.join('、') || '无'))); retrieval.append(row); }
  retrieval.append(el('p', 'legal-muted', '本次命中条文编号：' + (review.retrieval?.retrievedClauseIds?.join('、') || '无'))); target.append(retrieval);
}
function legalTraceText(plan) {
  const review = legalReviewFor(plan); if (!review) return ['【法律适用核对】', legacyLegalNotice];
  const lines = ['【法律适用核对 · 本版本保存的核对依据】', '已核验法条库 · 按案件检索 · 非实时全库查询', '适用地区：' + factText(review.jurisdiction), '核对日期：' + reviewDateLabel(review.reviewedAt), '法条核验日期：' + (corpusVerificationDates(review) || '见条文记录'), '条文库版本：' + factText(review.corpusVersion), '核对格式版本：' + factText(review.schemaVersion), '核对范围：' + factText(review.coverageNote), '用户填报与附件清单均未核实；条文核对不等于事实证明或责任认定。', ...(review.limitations || []).map((item) => '范围限制：' + item), '', '【法律核对所用事实】'];
  for (const fact of review.facts || []) lines.push(fact.id + ' · ' + fact.label + '：' + factText(fact.value), '对应字段：' + (fact.field || '材料清单'), '来源与状态：' + factOrigin(fact));
  const factMap = new Map((review.facts || []).map((fact) => [fact.id, fact]));
  for (const finding of review.findings || []) {
    lines.push('', '【核对项 ' + finding.id + '】' + finding.title, '关联动作：' + finding.actionId + ' · ' + (trackNames[finding.track] || finding.track), '适用状态：' + legalStatusName(finding), '核对建议：' + factText(finding.advice), '为什么关联本案：' + factText(finding.whyApplicable));
    for (const id of finding.factIds || []) { const fact = factMap.get(id); lines.push('关联事实：' + id + (fact ? ' · ' + fact.label + '：' + factText(fact.value) + '（' + factOrigin(fact) + '）' : ' · 本版本未保存对应事实')); }
    for (const [label, items] of [['仍需满足的条件', finding.conditions], ['待补充或核实的证据', finding.missingEvidence], ['适用提醒', finding.cautions]]) for (const item of items || []) lines.push(label + '：' + item);
    for (const citation of finding.citations || []) { lines.push('', '关联条文：' + citation.lawTitle + ' ' + citation.article, '条文全文：', citation.text || '本版本未保存条文全文。', ...citationEntries(citation).map(([label, value]) => label + '：' + factText(value)), '官方全文：' + factText(citation.officialUrl), '关联主题：' + (citation.topics?.join('、') || '未记载')); }
  }
  lines.push('', '【检索问题与命中记录】', '检索方式：' + factText(review.retrieval?.method));
  for (const query of review.retrieval?.queries || []) lines.push((query.id ? query.id + ' · ' : '') + query.question, '命中条文：' + (query.clauseIds?.join('、') || '无'));
  lines.push('本次命中条文编号：' + (review.retrieval?.retrievedClauseIds?.join('、') || '无')); return lines;
}
function runMaterials(run) {
  const rows = Array.isArray(run.plan?.materialSummary) ? run.plan.materialSummary : Array.isArray(run.materialSummary) ? run.materialSummary : [];
  const included = new Set(run.attachmentIds || []);
  const mapped = rows.filter((item) => !item.id || included.has(item.id)).map((item) => ({ ...item, id: item.id || item.attachmentId }));
  for (const id of included) if (!mapped.some((item) => item.id === id)) {
    const current = active?.attachments.find((item) => item.id === id);
    mapped.push({ id, name: current?.name || '历史材料 ' + id.slice(0, 8), mime: current?.mime, mode: 'unknown', warning: '本版本未提供识别摘要，请核对原始材料。' });
  }
  return mapped;
}
function materialDescription(item) {
  const modes = { text: '提取文字', document: '文档文字提取', image: '图片识别', vision: '图片识别', extracted: '提取文字', unsupported: '未识别', unknown: '待核对', omitted: '未处理', pdf: 'PDF 文字提取' };
  const imageNotAnalyzed = ['image', 'vision'].includes(item.mode) && !aiFor(currentRun()?.plan);
  const parts = [imageNotAnalyzed ? '图片已纳入材料清单；本次仅生成基础方案，图片内容未完成识别' : item.method || modes[item.mode] || item.mode || '识别方式待核对'];
  for (const key of ['summary', 'note', 'warning', 'reason', 'uncertainty']) if (typeof item[key] === 'string' && item[key]) parts.push(item[key]);
  if (Array.isArray(item.warnings)) parts.push(...item.warnings);
  if (Array.isArray(item.limitations)) parts.push(...item.limitations);
  if (item.textCharacters !== undefined || item.textChars !== undefined || item.charCount !== undefined) parts.push('提取文字 ' + (item.textCharacters ?? item.textChars ?? item.charCount) + ' 字符');
  if (item.pages) parts.push('共 ' + item.pages + ' 页');
  if (item.unreadablePages?.length) parts.push('未提取文字的页码：' + item.unreadablePages.join('、'));
  return parts.join('；');
}
function renderPlanState() {
  const run = currentRun(); const pending = running.get(active?.id); const failure = runErrors.get(active?.id);
  const notice = $('#generation-notice');
  notice.hidden = !pending && !failure;
  notice.className = 'notice' + (failure && !pending ? ' error' : '');
  notice.textContent = pending ? '正在生成本案件方案。可切换案件，完成后结果将自动归入原记录。' : failure || '';
  const selectionChanged = run && JSON.stringify([...selectedIds()].sort()) !== JSON.stringify([...(run.attachmentIds || [])].sort());
  const stale = Boolean(run && (dirty || Number(run.revision) !== Number(active.revision)));
  const archived = Boolean(run && active.status === 'archived');
  $('#stale-notice').hidden = !archived && !stale && !selectionChanged;
  $('#stale-notice').textContent = archived ? '案件已归档，下方为所选版本历史快照。' : stale ? '资料已更新，需重新生成。下方展示的是所选版本当时的案情与材料。' : '本次材料选择与该版本不同。下方仍为历史版本，重新生成后才会使用当前勾选材料。';
  renderControls();
}
function renderPlan() {
  const runs = activeRuns(); const run = currentRun(); const select = $('#run-select'); select.replaceChildren(); select.disabled = !runs.length;
  if (!runs.length) select.append(el('option', '', '暂无版本'));
  runs.forEach((item) => { const option = el('option', '', '第 ' + runOrdinal(active, item) + ' 版 · ' + dateTime(item.createdAt) + ' · 资料 v' + item.revision); option.value = item.id; option.selected = item.id === run?.id; select.append(option); });
  if (active) { if (run) selectedRuns.set(active.id, run.id); else selectedRuns.delete(active.id); }
  $('#plan-empty').hidden = Boolean(run); $('#plan-report').hidden = !run;
  $('#export-button').disabled = !run; $('#print-button').disabled = !run;
  if (!run) $('#print-report').textContent = '';
  $('#plan-meta').textContent = run ? active.number + ' · 第 ' + runOrdinal(active, run) + ' 版 · ' + dateTime(run.createdAt) + ' · 当时资料版本 ' + run.revision : '保存并生成后可查看方案与版本记录';
  const deleted = (active?.runs || []).filter((item) => item.deletedAt);
  $('#plan-empty h3').textContent = deleted.length ? '暂无可查看的回款方案' : '尚未生成回款方案';
  $('#plan-empty p').textContent = deleted.length ? '可在“已删除方案”中恢复历史版本，或生成新的回款方案。' : '补充欠款金额、付款到期日与项目现状，选择本次材料后生成。';
  renderDeletedRuns(deleted);
  const operationNotice = runOperationNotices.get(active?.id);
  $('#run-operation-notice').hidden = !operationNotice;
  $('#run-operation-notice').textContent = operationNotice || '';
  $('#run-visibility-help').hidden = active?.status !== 'archived' || !(runs.length || deleted.length);
  renderPlanState();
  if (!run?.plan) return;
  const plan = run.plan;
  renderOverview(plan, run); renderRunMaterials(run); renderLegalSummary(plan); renderAnalysis(plan); renderActions(plan); renderLegal(plan); renderEvidence(plan); renderLetter(plan); renderSnapshot(plan, run);
  const generation = plan.generation || {};
  $('#generation-footer').textContent = (legalReviewFor(plan) ? '法律适用核对与条文版本随本次方案保存，基于未核实的填报与材料清单；不等于律师审核、事实证明或责任认定。执行补充、材料识别及沟通草稿需人工复核。' : legacyLegalNotice + '。此处保留所选历史版本内容，方案研判、材料识别及沟通草稿需人工复核。') + (generation.provider || generation.model ? ' 生成服务：' + [generation.provider, generation.model].filter(Boolean).join(' / ') + '。' : '') + (generation.reason ? ' 生成说明：' + generation.reason : '');
  selectReportTab(reportTab);
}
function renderDeletedRuns(runs) {
  const details = $('#deleted-runs'); const target = $('#deleted-run-list'); target.replaceChildren();
  details.hidden = !runs.length;
  $('#deleted-run-count').textContent = '已删除方案（' + runs.length + '）';
  const recordId = active?.id;
  for (const run of runs) {
    const row = el('div', 'deleted-run-row'); const text = el('div');
    text.append(el('strong', '', '第 ' + runOrdinal(active, run) + ' 版 · ' + dateTime(run.createdAt)), el('span', '', '删除于 ' + dateTime(run.deletedAt) + ' · 当时资料版本 ' + run.revision));
    const restore = button('恢复', 'button secondary small restore-run');
    restore.setAttribute('aria-label', '恢复第 ' + runOrdinal(active, run) + ' 版方案');
    restore.addEventListener('click', () => changeRunVisibility({ recordId, runId: run.id, stateVersion: run.stateVersion ?? 0 }, true));
    row.append(text, restore); target.append(row);
  }
}
function closeDeleteRunDialog() {
  deleteRunTarget = null;
  if ($('#delete-run-dialog').open) $('#delete-run-dialog').close();
}
function openDeleteRunDialog() {
  const run = currentRun();
  if (!run || !active || pendingWrites || navigating || runOperationBusy || running.has(active.id) || conflicted) return;
  if (active.status === 'archived') { toast('恢复案件后操作'); return; }
  deleteRunTarget = { recordId: active.id, runId: run.id, stateVersion: run.stateVersion ?? 0 };
  $('#delete-run-case').textContent = active.number + ' · ' + active.title;
  $('#delete-run-version').textContent = '第 ' + runOrdinal(active, run) + ' 版 · ' + dateTime(run.createdAt) + ' · 资料 v' + run.revision;
  $('#delete-run-dialog').showModal(); renderControls(); $('#cancel-delete-run').focus();
}
async function changeRunVisibility(target, restore = false) {
  if (!target || active?.id !== target.recordId || navigating || pendingWrites || runOperationBusy || running.has(target.recordId) || conflicted) return;
  if (active.status === 'archived') { toast('恢复案件后操作'); closeDeleteRunDialog(); return; }
  const record = cache.get(target.recordId); const run = record?.runs.find((item) => item.id === target.runId);
  if (!run || Boolean(run.deletedAt) !== restore || Number(run.stateVersion ?? 0) !== Number(target.stateVersion)) {
    closeDeleteRunDialog(); toast('该方案状态已变更，请核对后重试'); renderPlan(); return;
  }
  runOperationBusy = true; runOperationNotices.delete(target.recordId); renderControls();
  try {
    await queueWrite(async () => {
      // Only visibility changes here: unsaved case fields stay in the form.
      const priorRuns = activeRuns(cache.get(target.recordId));
      const priorIndex = priorRuns.findIndex((item) => item.id === target.runId);
      const payload = await api('/api/records/' + encodeURIComponent(target.recordId) + '/runs/' + encodeURIComponent(target.runId) + (restore ? '/restore' : ''), { method: restore ? 'POST' : 'DELETE', body: { stateVersion: target.stateVersion } });
      const updated = acceptRecord(payload.record);
      if (restore) selectedRuns.set(target.recordId, target.runId);
      else if (selectedRuns.get(target.recordId) === target.runId) {
        const remaining = activeRuns(updated);
        const nearest = remaining[Math.min(Math.max(priorIndex, 0), remaining.length - 1)];
        if (nearest) selectedRuns.set(target.recordId, nearest.id); else selectedRuns.delete(target.recordId);
      }
      closeDeleteRunDialog();
      if (active?.id === target.recordId) { renderHeader(); renderPlan(); }
      toast(restore ? '方案已恢复' : '本版方案已删除，案件资料和附件保留');
    });
  } catch (error) {
    closeDeleteRunDialog();
    let notice = error.message || '方案操作未完成，请重试。';
    if (error.status === 409) {
      notice = '方案状态已变更，请核对后重试。当前填写内容已保留。';
      try { const payload = await api('/api/records/' + encodeURIComponent(target.recordId)); acceptRecord(payload.record); }
      catch { notice = '方案状态已变更，刷新方案失败。当前填写内容已保留，请稍后重试。'; }
    }
    runOperationNotices.set(target.recordId, notice);
    if (active?.id === target.recordId) { renderHeader(); renderPlan(); } else toast(notice);
  } finally { runOperationBusy = false; renderControls(); }
}
function sourceLink(source, label) {
  const link = el('a', '', label || source.title); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = source.title + ' · ' + source.locator; return link;
}
function renderOverview(plan, run) {
  const panel = el('article', 'panel overview-panel'); const top = el('div', 'overview-top'); const priority = plan.priority || {};
  top.append(el('h3', '', '回款推进建议'), el('span', 'priority-tag ' + (priority.tone || ''), priority.label || '待核查')); panel.append(top, el('p', '', plan.strategy || plan.summary));
  const metrics = el('div', 'metric-row');
  const beforeDue = run.inputSnapshot?.dueDate > plan.generatedAt;
  for (const [label, value, compact] of [['待核对欠款', money(plan.amount ?? run.inputSnapshot?.amount), false], ['按当时填报到期日计算', beforeDue ? '尚未到期' : plan.overdueDays + ' 天', false], ['内部推进安排', priority.label || '按方案分工', true]]) {
    const metric = el('div'); metric.append(el('span', 'metric-label', label), el('strong', 'metric-value' + (compact ? ' compact' : ''), value)); metrics.append(metric);
  }
  panel.append(metrics); $('#report-overview').replaceChildren(panel);
}
function renderRunMaterials(run) {
  const materials = runMaterials(run); const target = $('#run-materials'); target.replaceChildren();
  $('#run-material-count').textContent = (run.attachmentIds || []).length + ' 个 · 当时选中 · 清单及内容均待核实';
  if (!materials.length) target.append(el('div', 'material-run-row', '本版本未使用附件，仅依据当时填报的案情。'));
  for (const item of materials) {
    const row = el('div', 'material-run-row');
    row.append(el('strong', '', item.name || '材料 ' + item.id), el('span', '', materialDescription(item)));
    if (item.id && !active.attachments.some((attachment) => attachment.id === item.id)) row.append(el('small', '', ' · 已从当前资料移除；本行保留当时版本记录'));
    target.append(row);
  }
  const findings = aiFor(run.plan)?.materialFindings || [];
  for (const finding of findings) {
    const name = materials.find((item) => item.id === finding.attachmentId)?.name || '本次材料';
    const row = el('div', 'material-run-row'); row.append(el('strong', '', name + ' · 识别提示'), el('span', '', finding.finding), el('small', '', [finding.location, finding.uncertainty].filter(Boolean).join('；'))); target.append(row);
  }
}
function renderAnalysis(plan) {
  const ai = aiFor(plan); const target = $('#report-analysis'); target.replaceChildren(); if (!ai) return;
  const panel = el('article', 'panel analysis-panel'); panel.append(el('h3', '', '执行研判 · 需人工复核'), el('p', 'analysis-help', '以下为推进工作的补充意见。法律适用状态与原文依据以本版本“法律依据”中的核对项为准。'));
  if (ai.analysis) panel.append(el('p', '', ai.analysis));
  if (ai.strategy) panel.append(el('h4', '', '推进策略'), el('p', '', ai.strategy));
  if (ai.followUpQuestions?.length) panel.append(el('h4', '', '待进一步确认'), list(ai.followUpQuestions)); target.append(panel);
}
function renderActions(plan) {
  const grid = el('div', 'action-grid'); const recommendations = aiFor(plan)?.recommendations || []; const review = legalReviewFor(plan);
  for (const [track, label] of Object.entries(trackNames)) {
    const actions = (plan.actions || []).filter((action) => action.track === track); const card = el('article', 'action-card');
    if (!actions.length) { card.append(el('div', 'action-kicker', label), el('h3', '', '本版本未设置专项动作'), el('p', '', '请根据实际项目情况核查是否需要安排。')); grid.append(card); continue; }
    for (const action of actions) {
      const kind = adviceKind(action, review); const findings = legalFindingsFor(plan, action); const isBusiness = kind === '业务建议';
      const header = el('div', 'action-header'); const heading = el('div'); heading.append(el('div', 'action-kicker', kind + ' · ' + label), el('h3', '', !isBusiness && review ? findings[0]?.title || '本动作缺少法律核对记录' : action.title)); header.append(heading, el('span', 'action-priority', action.priority)); card.append(header);
      if (isBusiness || !review) card.append(el('p', '', action.reason), list(action.steps, true));
      if (findings.length) {
        const grounding = el('div', 'action-grounding' + (isBusiness ? ' business-grounding' : '')); if (isBusiness) grounding.append(el('h4', '', '法律条件核对'));
        for (const finding of findings) { const row = el('div', 'action-finding'); row.append(legalStatusTag(finding), el('p', '', finding.advice)); if (finding.missingEvidence?.length) row.append(el('p', 'action-finding-missing', '待补充或核实 ' + finding.missingEvidence.length + ' 项，详见法律依据。')); row.append(legalDetailButton(finding, '查看对应条文与适用理由')); grounding.append(row); }
        card.append(grounding);
      } else if (!isBusiness) card.append(el('p', 'action-legal-unavailable', review ? '本动作未保存逐条法律核对，需另行核实后执行。' : legacyLegalNotice));
      card.append(el('div', 'action-meta', '负责人：' + action.owner));
      const details = el('details');
      if (!isBusiness && review) {
        const tasks = legalReviewTasks(findings); details.append(el('summary', '', '核对任务' + (tasks.length ? ' · ' + tasks.length + ' 项' : '')));
        if (tasks.length) details.append(list(tasks.slice(0, 5), true)); else details.append(el('p', '', '本动作尚无完整核对任务，需补充法律核对记录。'));
        if (tasks.length > 5) details.append(el('p', '', '其余 ' + (tasks.length - 5) + ' 项及适用条件，请在法律依据中逐条查看。'));
        if (findings.length) details.append(legalDetailButton(findings[0], '查看完整核对任务与条文'));
      } else {
        details.append(el('summary', '', isBusiness ? '协作条件与所需材料' : '执行安排与所需材料 · 需复核'), el('p', '', '适用条件：' + action.condition), el('p', '', '推进时间：' + action.timing), el('p', '', '材料：' + (action.materials || []).join('、')));
      }
      card.append(details);
    }
    for (const recommendation of recommendations.filter((item) => item.track === track)) {
      const supplement = el('div', 'supplement-advice'); const isLegal = ['legal', 'complaint'].includes(track); const findings = legalRecommendationFindings(review, recommendation);
      supplement.append(el('h4', '', isLegal ? recommendation.contentOrigin === 'review-template' ? '法律核对事项' : '执行补充 · 需人工复核' : '业务补充 · 需复核'));
      if (isLegal && review && !findings.length) supplement.append(el('p', '', '该条补充未关联本版本有效核对项，需核实依据后再使用。'));
      else { supplement.append(el('p', '', recommendation.advice), list(recommendation.steps, true)); if (isLegal) { supplement.append(el('p', 'supplement-basis', review ? '所依据的法律核对项：' + findings.map((finding) => finding.id).join('、') + '。本段不改变各核对项的适用状态。' : '历史补充意见未保存逐条法律核对。')); for (const finding of findings) supplement.append(legalDetailButton(finding, finding.id + ' · 查看依据')); } }
      card.append(supplement);
    }
    grid.append(card);
  }
  const timelinePanel = el('article', 'panel timeline-panel'); timelinePanel.append(el('h3', '', '建议推进顺序')); const timeline = el('div', 'timeline');
  for (const stage of plan.timeline || []) { const node = el('div', 'timeline-stage'); node.append(el('span', '', '阶段 ' + stage.phase), el('h4', '', stage.title), list(stage.items)); timeline.append(node); }
  timelinePanel.append(timeline); $('#report-actions').replaceChildren(grid, timelinePanel);
}
function renderEvidence(plan) {
  const gaps = el('article', 'panel evidence-card'); gaps.append(el('h3', '', '建议补充与确认'), list(plan.missingInfo?.length ? plan.missingInfo : ['填报项目已补充，仍需核对实际材料及其证明力。']));
  const evidence = el('article', 'panel evidence-card'); evidence.append(el('h3', '', '材料准备清单（当时填报）'));
  for (const item of plan.evidenceChecklist || []) { const row = el('div', 'evidence-row' + (item.present ? ' present' : '')); const copy = el('div'); copy.append(el('strong', '', item.label), el('p', '', item.reason)); row.append(copy, el('span', 'evidence-status', item.present ? '填报已持有' : '待准备 / 核实')); evidence.append(row); }
  const caution = el('article', 'panel evidence-card'); caution.append(el('h3', '', '核查提醒'), list(plan.caution)); $('#report-evidence').replaceChildren(gaps, evidence, caution);
}
function renderLetter(plan) {
  const panel = el('article', 'panel letter-panel'); const top = el('div', 'letter-top'); const copy = button('复制草稿'); const aiDraft = aiFor(plan)?.communicationDraft; const draft = el('pre', 'letter-text');
  top.append(el('h3', '', '回款与项目事项沟通函'), copy); panel.append(top, el('p', 'letter-help', '请补齐名称、联系人及回复日期，并核对事实、金额、日期与法律表述后使用。'));
  const show = () => { draft.textContent = draftMode === 'supplement' && aiDraft ? aiDraft : plan.letterDraft || ''; };
  if (aiDraft) { const choice = el('div', 'draft-choice'); const label = el('label', '', '草稿版本'); label.htmlFor = 'draft-choice'; const select = el('select'); select.id = 'draft-choice'; for (const [value, text] of [['supplement', '沟通草稿 · 需复核'], ['rules', '基础草稿']]) { const option = el('option', '', text); option.value = value; select.append(option); } select.value = draftMode; select.addEventListener('change', () => { draftMode = select.value; show(); }); choice.append(label, select); panel.append(choice); }
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(draft.textContent); toast('草稿已复制，请核对后使用'); } catch { toast('浏览器未允许复制，请选中文本复制'); } });
  show(); panel.append(draft); $('#report-letter').replaceChildren(panel);
}
function renderSnapshot(plan, run) {
  const panel = el('article', 'panel snapshot-panel'); panel.append(el('h3', '', '当时案情 · 资料版本 ' + run.revision)); const table = el('table', 'snapshot-table');
  for (const fact of plan.facts || []) { const row = el('tr'); row.append(el('th', '', fact.label), el('td', '', fact.value)); table.append(row); }
  panel.append(table, el('p', 'report-footnote', '此处为生成该版本时的填报快照，内容均未核实；当前基本信息请在“基本信息”中查看。')); $('#report-snapshot').replaceChildren(panel);
}
function renderNotes() {
  const target = $('#notes-list'); target.replaceChildren(); const notes = active?.notes || [];
  if (!notes.length) target.append(el('p', 'note-empty', '暂无跟进记录。添加备注后可在本案件中持续查看。'));
  for (const note of notes) { const node = el('article', 'note-item'); const time = el('time', '', dateTime(note.createdAt)); time.dateTime = note.createdAt; node.append(time, el('p', '', note.body)); target.append(node); }
}
function renderCurrent() { renderHeader(); renderAttachments(); renderPlan(); renderNotes(); renderControls(); }
async function beginAnalysis() {
  if (running.has(active?.id) || navigating) return;
  clearError();
  try {
    await queueWrite(async () => {
      // Draft saving and analysis validation are intentionally separate.
      const input = getInput();
      if (!form.checkValidity()) { selectCaseTab('info'); form.reportValidity(); return; }
      try { generatePlan(input, chinaDateOffset()); } catch (error) { selectCaseTab('info'); $('#form-error').textContent = error.message; $('#form-error').hidden = false; return; }
      const record = await saveDraftNow({ force: true });
      const recordId = record.id; const ids = selectedIds(record);
      if (record.attachments.filter((item) => ids.includes(item.id)).reduce((sum, item) => sum + item.size, 0) > 12 * 1048576) throw new Error('本次选中资料超过 12 MB，请减少选中材料后再生成。');
      if (running.has(recordId)) return;
      running.set(recordId, { revision: record.revision, attachmentIds: [...ids] }); runErrors.delete(recordId);
      selectCaseTab('plan'); renderPlanState(); renderHistory();
      // Do not abort this request when switching records. The result belongs to recordId.
      void api('/api/records/' + encodeURIComponent(recordId) + '/analyze', { method: 'POST', body: { revision: record.revision, attachmentIds: ids } }).then((payload) => {
        const received = payload.record;
        if (payload.run && !(received.runs || []).some((run) => run.id === payload.run.id)) received.runs = [...(received.runs || []), { ...payload.run, plan: payload.run.plan || payload.plan }];
        const updated = acceptRecord(received);
        if (payload.run) selectedRuns.set(recordId, payload.run.id);
        running.delete(recordId);
        if (active?.id === recordId) { renderCurrent(); if (updated.status === 'archived') toast(record.number + ' 的回款方案已保存，案件已归档'); else if (payload.stale) toast(record.number + ' 的方案已保存。生成期间资料发生变更，请重新生成以更新。'); else toast(record.number + ' 的回款方案已保存，请复核后使用'); }
        else toast(updated.number + ' 的回款方案已生成并归档');
        renderHistory();
      }).catch((error) => {
        running.delete(recordId); runErrors.set(recordId, '本次生成未完成：' + error.message + '。已保存的案情与材料仍保留，可重试。');
        if (active?.id === recordId) { showError(error, recordId); renderPlanState(); } else toast(record.number + ' 生成未完成，案情与材料已保留');
        renderHistory();
      });
    });
  } catch (error) { showError(error); }
}
function reportText() {
  const run = currentRun(); if (!run) return '';
  const plan = run.plan; const ai = aiFor(plan); const review = legalReviewFor(plan); const lines = ['企业 AI 回款方案工作台 · 回款方案（需人工复核）', '案件编号：' + active.number, '当前案件名称：' + active.title, '方案版本：第 ' + runOrdinal(active, run) + ' 版', '资料版本：' + run.revision, '生成时间：' + dateTime(run.createdAt), '当前资料版本：' + active.revision, '版本状态：' + (active.status === 'archived' ? '案件已归档，下文为所选版本历史快照' : dirty || Number(run.revision) !== Number(active.revision) ? '资料已更新，需重新生成；下文为历史快照' : '对应当前已保存资料'), '', '【当时案情】', ...(plan.facts || []).map((fact) => fact.label + '：' + fact.value), '', '【本次材料清单与识别提示】'];
  const materials = runMaterials(run);
  lines.push(...(materials.length ? materials.map((item) => '- ' + item.name + '：' + materialDescription(item)) : ['本版本未使用附件，仅依据当时填报信息。']));
  for (const finding of ai?.materialFindings || []) lines.push('材料识别：' + (materials.find((item) => item.id === finding.attachmentId)?.name || finding.attachmentId) + '；' + finding.finding + '；位置：' + (finding.location || '待核对') + '；不确定性：' + (finding.uncertainty || '请核对原文'));
  lines.push('', '【整体推进建议】', plan.summary || '', plan.strategy || '', plan.priority?.label || '', plan.priority?.reason || '');
  lines.push('', ...legalTraceText(plan));
  if (ai) lines.push('', '【执行研判 · 需人工复核】', '法律适用状态与条文依据以本版本保存的法律核对项为准。', ai.analysis || '', ai.strategy || '', ...(ai.followUpQuestions || []).map((item) => '待确认：' + item));
  for (const action of plan.actions || []) {
    const kind = adviceKind(action, review); const findings = legalFindingsFor(plan, action);
    const reviewedLegal = kind === '法律建议' && review;
    lines.push('', '【' + kind + ' · ' + trackNames[action.track] + '】' + (reviewedLegal ? findings[0]?.title || '本动作缺少法律核对记录' : action.title), '负责人：' + action.owner);
    if (!reviewedLegal) lines.push('时间：' + action.timing, '原因：' + action.reason);
    for (const finding of findings) lines.push((kind === '业务建议' ? '法律条件核对' : '法律适用核对') + '：' + finding.id + ' · ' + legalStatusName(finding), '核对建议：' + finding.advice, '完整条文及适用理由：见上文核对项 ' + finding.id);
    if (kind === '法律建议' && !findings.length) lines.push(review ? '本动作未保存逐条法律核对，需另行核实后执行。' : legacyLegalNotice);
    if (reviewedLegal) lines.push('核对任务：', ...legalReviewTasks(findings).map((step, index) => (index + 1) + '. ' + step), '完整适用条件与条文：见上文核对项 ' + findings.map((finding) => finding.id).join('、'));
    else lines.push('执行安排（需核实适用条件后决定）：', ...(action.steps || []).map((step, index) => (index + 1) + '. ' + step), '适用条件：' + action.condition, '材料：' + (action.materials || []).join('、'));
  }
  for (const recommendation of ai?.recommendations || []) {
    const isLegal = ['legal', 'complaint'].includes(recommendation.track); const findings = legalRecommendationFindings(review, recommendation);
    lines.push('', '【' + (isLegal ? recommendation.contentOrigin === 'review-template' ? '法律核对事项' : '执行补充 · 需人工复核' : '业务补充 · 需复核') + ' · ' + trackNames[recommendation.track] + '】');
    if (isLegal && review && !findings.length) lines.push('该条补充未关联本版本有效核对项，需核实依据后再使用。');
    else { lines.push(recommendation.advice, ...(recommendation.steps || []).map((step) => '- ' + step)); if (isLegal) lines.push(review ? '所依据的核对项：' + findings.map((finding) => finding.id).join('、') + '；本段不改变各项适用状态。' : '历史补充意见未保存逐条法律核对。'); }
  }
  lines.push('', '【推进顺序】', ...(plan.timeline || []).flatMap((stage) => [stage.phase + ' ' + stage.title, ...(stage.items || []).map((item) => '- ' + item)]), '', '【证据缺口】', ...(plan.missingInfo || []).map((item) => '- ' + item), '', '【材料准备清单】', ...(plan.evidenceChecklist || []).map((item) => (item.present ? '[当时填报已持有] ' : '[待准备] ') + item.label + '：' + item.reason), '', '【基础沟通函草稿】', plan.letterDraft || '');
  if (ai?.communicationDraft) lines.push('', '【沟通草稿 · 需复核】', ai.communicationDraft);
  lines.push('', '【核查提醒】', ...(plan.caution || []), '', '【当前案件跟进记录】', ...(active.notes || []).map((note) => dateTime(note.createdAt) + ' ' + note.body), '', '生成服务：' + [plan.generation?.provider, plan.generation?.model].filter(Boolean).join(' / '), '生成说明：' + (plan.generation?.reason || '按本版本案情与选中材料生成'), review ? '本次法律核对与条文版本已随方案保存；不等于律师审核、事实证明或责任认定。执行研判、材料识别与草稿需人工复核。' : legacyLegalNotice + '。历史内容需人工复核。');
  return lines.join('\n');
}
function renderSources() {
  for (const source of SOURCES) {
    const card = el('article', 'panel source-card'); card.append(el('span', 'source-kind', source.kind === 'law' ? '法律法规 · 官方全文' : '官方渠道 · 办事条件'), el('h2', '', source.title), el('p', 'source-meta', source.issuer), el('p', '', '适用提示摘要：' + source.summary));
    if (source.articles?.length) card.append(el('p', '', '条号定位：' + source.articles.join('、')));
    card.append(el('p', 'source-meta', source.locator), el('p', 'source-meta', source.versionNote), el('p', 'source-meta', '资料核查：' + source.verifiedAt), sourceLink(source, source.kind === 'law' ? '查看官方原文' : '前往官方入口'));
    if (source.authorityUrl) card.append(sourceLink({ ...source, url: source.authorityUrl }, '官方办事说明'));
    if (source.rulesUrl) card.append(sourceLink({ ...source, url: source.rulesUrl }, '核查受理规则')); $('#source-catalog').append(card);
  }
}
async function checkHealth() {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
  try {
    service = await api('/api/health', { signal: controller.signal });
    $('#storage-status').textContent = service.storageConfigured === false ? '数据存储未配置' : '服务器记录存储';
    $('#storage-dot').className = 'connection-dot ' + (service.storageConfigured === false ? 'error' : 'connected');
  } catch { $('#storage-status').textContent = '暂时无法连接服务器'; $('#storage-dot').className = 'connection-dot error'; }
  finally { clearTimeout(timer); }
}

form.addEventListener('input', () => { dirty = true; editVersion += 1; clearError(); renderHeader(); renderPlanState(); });
form.addEventListener('change', () => { dirty = true; editVersion += 1; clearError(); renderHeader(); renderPlanState(); });
form.addEventListener('submit', (event) => { event.preventDefault(); clearError(); saveDraft({ force: true }).then(() => toast('基本信息已保存')).catch(showError); });
$('#save-button').addEventListener('click', () => { clearError(); saveDraft({ force: true }).then(() => toast('案件已保存')).catch(showError); });
$('#generate-button').addEventListener('click', beginAnalysis);
$('#new-record').addEventListener('click', () => navigate());
$('#create-sample').addEventListener('click', () => navigate(null, true));
$('#reload-record').addEventListener('click', () => { if (active) navigate(active.id, false, true); });
$('#archive-button').addEventListener('click', async () => {
  const recordId = active?.id; if (!recordId) return;
  clearError();
  try { await queueWrite(async () => { const record = await saveDraftNow(); const status = record.status === 'archived' ? 'active' : 'archived'; const payload = await api('/api/records/' + encodeURIComponent(recordId), { method: 'PATCH', body: { revision: record.revision, status } }); acceptRecord(payload.record); if (active?.id === recordId) renderCurrent(); toast(status === 'archived' ? '案件已归档，可在“已归档”中查看与恢复' : '案件已恢复为进行中'); }); }
  catch (error) { showError(error, recordId); }
});
$('#choose-files').addEventListener('click', () => $('#file-input').click()); $('#choose-images').addEventListener('click', () => $('#image-input').click());
for (const selector of ['#file-input', '#image-input']) $(selector).addEventListener('change', (event) => { uploadFiles(event.target.files); event.target.value = ''; });
const dropZone = $('#drop-zone');
for (const type of ['dragenter', 'dragover']) dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add('drag-over'); });
for (const type of ['dragleave', 'drop']) dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.remove('drag-over'); });
dropZone.addEventListener('drop', (event) => { if (!pendingWrites && !conflicted) uploadFiles(event.dataTransfer.files); });
$('#close-preview').addEventListener('click', () => $('#preview-dialog').close());
$('#preview-dialog').addEventListener('close', () => $('#preview-content').replaceChildren());
$('#run-select').addEventListener('change', (event) => { if (active) { selectedRuns.set(active.id, event.target.value); renderPlan(); } });
$('#delete-run').addEventListener('click', openDeleteRunDialog);
$('#cancel-delete-run').addEventListener('click', () => { closeDeleteRunDialog(); renderControls(); });
$('#confirm-delete-run').addEventListener('click', () => changeRunVisibility(deleteRunTarget));
$('#delete-run-dialog').addEventListener('cancel', (event) => { if (runOperationBusy) event.preventDefault(); });
$('#delete-run-dialog').addEventListener('close', () => { deleteRunTarget = null; renderControls(); });
$('#note-body').addEventListener('input', () => noteDrafts.set(active?.id || 'draft', $('#note-body').value));
$('#note-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const body = $('#note-body').value.trim(); if (!body) { toast('请先填写跟进内容'); return; }
  const origin = active?.id;
  try { await queueWrite(async () => { const record = await saveDraftNow({ force: true }); const recordId = record.id; const payload = await api('/api/records/' + encodeURIComponent(recordId) + '/notes', { method: 'POST', body: { body } }); acceptRecord(payload.record); if (active?.id === recordId) { if ($('#note-body').value.trim() === body) { $('#note-body').value = ''; noteDrafts.delete(recordId); } renderCurrent(); } toast('跟进记录已保存'); }); }
  catch (error) { showError(error, origin || active?.id); }
});
$('#export-button').addEventListener('click', () => { const run = currentRun(); if (!run) return; const url = URL.createObjectURL(new Blob(['\uFEFF' + reportText()], { type: 'text/plain;charset=utf-8' })); const link = el('a'); link.href = url; link.download = '回款方案-' + active.number + '-资料v' + run.revision + '-' + run.id.slice(0, 8) + '.txt'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
$('#print-button').addEventListener('click', () => { if (!currentRun()) return; $('#print-report').textContent = reportText(); window.print(); });
window.addEventListener('beforeprint', () => { $('#print-report').textContent = !$('#overview-view').hidden ? overviewReportText() : reportText(); });
window.addEventListener('beforeunload', (event) => { if (dirty || pendingWrites > 0) { event.preventDefault(); event.returnValue = ''; } });
$('#history-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadHistory(), 250); });
$('#refresh-history').addEventListener('click', () => loadHistory());
$$('[data-status]').forEach((node) => node.addEventListener('click', () => { filterStatus = node.dataset.status; $$('[data-status]').forEach((item) => { item.classList.toggle('active', item === node); item.setAttribute('aria-pressed', String(item === node)); }); loadHistory(); }));
$$('[data-view]').forEach((node) => node.addEventListener('click', () => showView(node.dataset.view)));
$('.brand').addEventListener('click', (event) => { event.preventDefault(); showView('workspace'); });
$$('[data-case-tab]').forEach((node) => node.addEventListener('click', () => { if (!navigating) selectCaseTab(node.dataset.caseTab); }));
$$('[data-report-tab]').forEach((node) => node.addEventListener('click', () => selectReportTab(node.dataset.reportTab)));
tabKeyboard($$('[data-case-tab]'), (node) => { if (!navigating) selectCaseTab(node.dataset.caseTab); }); tabKeyboard($$('[data-report-tab]'), (node) => selectReportTab(node.dataset.reportTab));
initOverview({ api, openRecord: async (id) => { await navigate(id); if (!$('#overview-view').hidden && !$('#workspace-error').hidden) throw new Error($('#workspace-error').textContent); } });
initProvider({ api });
fillForm(null); renderSources(); renderCurrent(); selectCaseTab(caseTab); checkHealth(); loadHistory({ initial: true });

import { generatePlan } from './engine.js';
import { SOURCES } from './sources.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const form = $('#case-form');
const sourceMap = new Map(SOURCES.map((source) => [source.id, source]));
const trackNames = { repair: '维修与履约', business: '商务与财务', legal: '法务与争议解决', complaint: '投诉与主管渠道' };
const cache = new Map();
const selections = new Map();
const selectedRuns = new Map();
const noteDrafts = new Map();
const running = new Map();
const runErrors = new Map();
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
function acceptRecord(record) {
  if (!record?.id) throw new Error('记录响应不完整，请重新载入。');
  const previous = cache.get(record.id);
  // Late analysis responses must never replace more recent input or attachments.
  const previousIsNewer = previous && (previous.revision > record.revision || (previous.revision === record.revision && String(previous.updatedAt) > String(record.updatedAt)));
  const merged = previousIsNewer ? { ...previous } : { ...record };
  merged.runs = mergedItems(previous?.runs, record.runs);
  merged.notes = mergedItems(previous?.notes, record.notes);
  merged.attachments ||= [];
  cache.set(record.id, merged);
  if (!selections.has(record.id)) selections.set(record.id, new Set(merged.attachments.map((item) => item.id)));
  const summary = { id: merged.id, number: merged.number, title: merged.title, status: merged.status, revision: merged.revision, debtorName: merged.input?.debtorName, amount: merged.input?.amount, dueDate: merged.input?.dueDate, attachmentCount: merged.attachments.length, runCount: merged.runs.length, updatedAt: merged.updatedAt };
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
  $$('.history-item').forEach((node) => { node.disabled = navigating; });
  $$('.remove-file').forEach((node) => { node.disabled = busy || archived || conflicted; });
  form.inert = navigating || archived;
}
function renderHeader() {
  $('#case-number').textContent = active ? active.number + ' · 资料版本 ' + active.revision : '新建记录 · 尚未保存';
  $('#case-title').textContent = form.elements.title.value.trim() || active?.title || '未命名回款案件';
  const status = active?.status === 'archived' ? '已归档' : active ? '进行中' : '草稿';
  $('#case-status').textContent = status; $('#case-status').className = 'status-tag' + (active?.status === 'archived' ? ' archived' : active ? '' : ' draft');
  $('#save-state').classList.toggle('unsaved', dirty);
  $('#save-state').textContent = conflicted ? '版本冲突 · 当前填写内容已保留' : dirty ? '有未保存修改 · 切换案件前自动保存' : active ? '已保存 · 最近更新 ' + dateTime(active.updatedAt) : '填写后保存，资料与方案将归档至本记录';
  $('#attachment-count').textContent = active?.attachments?.length || 0; $('#run-count').textContent = active?.runs?.length || 0; $('#note-count').textContent = active?.notes?.length || 0;
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
      if (!known || (known.revision <= summary.revision && String(known.updatedAt) <= String(summary.updatedAt))) return summary;
      return { ...summary, title: known.title, status: known.status, revision: known.revision, debtorName: known.input?.debtorName, amount: known.input?.amount, dueDate: known.input?.dueDate, attachmentCount: known.attachments.length, runCount: known.runs.length, updatedAt: known.updatedAt };
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
  if (!active?.runs?.length) return null;
  return active.runs.find((run) => run.id === selectedRuns.get(active.id)) || active.runs[0];
}
function aiFor(plan) { return plan?.generation?.mode === 'ai' ? plan.ai : null; }
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
  $('#stale-notice').hidden = !stale && !selectionChanged;
  $('#stale-notice').textContent = stale ? '资料已更新，需重新生成。下方展示的是所选版本当时的案情与材料。' : '本次材料选择与该版本不同。下方仍为历史版本，重新生成后才会使用当前勾选材料。';
  renderControls();
}
function renderPlan() {
  const runs = active?.runs || []; const run = currentRun(); const select = $('#run-select'); select.replaceChildren(); select.disabled = !runs.length;
  if (!runs.length) select.append(el('option', '', '暂无版本'));
  runs.forEach((item, index) => { const option = el('option', '', '第 ' + (runs.length - index) + ' 版 · ' + dateTime(item.createdAt) + ' · 资料 v' + item.revision); option.value = item.id; option.selected = item.id === run?.id; select.append(option); });
  $('#plan-empty').hidden = Boolean(run); $('#plan-report').hidden = !run;
  $('#export-button').disabled = !run; $('#print-button').disabled = !run;
  $('#plan-meta').textContent = run ? active.number + ' · 第 ' + (runs.length - runs.indexOf(run)) + ' 版 · ' + dateTime(run.createdAt) + ' · 当时资料版本 ' + run.revision : '保存并生成后可查看方案与版本记录';
  renderPlanState();
  if (!run?.plan) return;
  const plan = run.plan;
  renderOverview(plan, run); renderRunMaterials(run); renderAnalysis(plan); renderActions(plan); renderEvidence(plan); renderLetter(plan); renderSnapshot(plan, run);
  const generation = plan.generation || {};
  $('#generation-footer').textContent = '金额、日期、适用条件及官方来源由固定规则形成。方案研判、材料识别及沟通草稿需人工复核；未进行实时法律检索。' + (generation.provider || generation.model ? ' 生成服务：' + [generation.provider, generation.model].filter(Boolean).join(' / ') + '。' : '') + (generation.reason ? ' 生成说明：' + generation.reason : '');
  selectReportTab(reportTab);
}
function sourceLinks(ids = []) {
  const links = el('div', 'source-links');
  ids.forEach((id) => { const source = sourceMap.get(id); if (source) links.append(sourceLink(source)); });
  return links;
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
  $('#run-material-count').textContent = (run.attachmentIds || []).length + ' 个 · 当时选中';
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
  const panel = el('article', 'panel analysis-panel'); panel.append(el('h3', '', '方案研判'));
  if (ai.analysis) panel.append(el('p', '', ai.analysis));
  if (ai.strategy) panel.append(el('h4', '', '推进策略'), el('p', '', ai.strategy));
  if (ai.followUpQuestions?.length) panel.append(el('h4', '', '待进一步确认'), list(ai.followUpQuestions)); target.append(panel);
}
function renderActions(plan) {
  const grid = el('div', 'action-grid'); const recommendations = aiFor(plan)?.recommendations || [];
  for (const [track, label] of Object.entries(trackNames)) {
    const actions = (plan.actions || []).filter((action) => action.track === track); const card = el('article', 'action-card');
    if (!actions.length) { card.append(el('div', 'action-kicker', label), el('h3', '', '本版本未设置专项动作'), el('p', '', '请根据实际项目情况核查是否需要安排。')); grid.append(card); continue; }
    for (const action of actions) {
      const header = el('div', 'action-header'); const heading = el('div'); heading.append(el('div', 'action-kicker', label), el('h3', '', action.title)); header.append(heading, el('span', 'action-priority', action.priority));
      card.append(header, el('p', '', action.reason), list(action.steps, true), el('div', 'action-meta', '负责人：' + action.owner));
      const details = el('details'); details.append(el('summary', '', '适用条件与所需材料'), el('p', '', '适用条件：' + action.condition), el('p', '', '推进时间：' + action.timing), el('p', '', '材料：' + (action.materials || []).join('、'))); card.append(details, sourceLinks(action.sourceIds));
    }
    for (const recommendation of recommendations.filter((item) => item.track === track)) { const supplement = el('div', 'supplement-advice'); supplement.append(el('h4', '', '推进建议 · 需复核'), el('p', '', recommendation.advice), list(recommendation.steps, true), sourceLinks(recommendation.sourceIds)); card.append(supplement); }
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
  panel.append(table, el('p', 'report-footnote', '此处为生成该版本时的案情快照，当前基本信息请在“基本信息”中查看。')); $('#report-snapshot').replaceChildren(panel);
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
        if (active?.id === recordId) { renderCurrent(); if (payload.stale) toast('方案已保存。生成期间资料发生变更，请重新生成以更新。'); else toast('回款方案已保存至当前案件，请复核后使用'); }
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
  const plan = run.plan; const ai = aiFor(plan); const lines = ['应收账款管理平台 · 回款方案（需人工复核）', '案件编号：' + active.number, '当前案件名称：' + active.title, '方案版本：第 ' + (active.runs.length - active.runs.indexOf(run)) + ' 版', '资料版本：' + run.revision, '生成时间：' + dateTime(run.createdAt), '当前资料版本：' + active.revision, '版本状态：' + (dirty || Number(run.revision) !== Number(active.revision) ? '资料已更新，需重新生成；下文为历史快照' : '对应当前已保存资料'), '', '【当时案情】', ...(plan.facts || []).map((fact) => fact.label + '：' + fact.value), '', '【本次材料清单与识别提示】'];
  const materials = runMaterials(run);
  lines.push(...(materials.length ? materials.map((item) => '- ' + item.name + '：' + materialDescription(item)) : ['本版本未使用附件，仅依据当时填报信息。']));
  for (const finding of ai?.materialFindings || []) lines.push('材料识别：' + (materials.find((item) => item.id === finding.attachmentId)?.name || finding.attachmentId) + '；' + finding.finding + '；位置：' + (finding.location || '待核对') + '；不确定性：' + (finding.uncertainty || '请核对原文'));
  lines.push('', '【整体推进建议】', plan.summary || '', plan.strategy || '', plan.priority?.label || '', plan.priority?.reason || '');
  if (ai) lines.push('', '【方案研判】', ai.analysis || '', ai.strategy || '', ...(ai.followUpQuestions || []).map((item) => '待确认：' + item));
  for (const action of plan.actions || []) {
    lines.push('', '【' + trackNames[action.track] + '】' + action.title, '负责人：' + action.owner, '时间：' + action.timing, '原因：' + action.reason, ...(action.steps || []).map((step, index) => (index + 1) + '. ' + step), '适用条件：' + action.condition, '材料：' + (action.materials || []).join('、'));
    for (const id of action.sourceIds || []) { const source = sourceMap.get(id); if (source) lines.push('官方来源：' + source.title, source.url, '定位：' + (source.articles?.join('、') || source.locator), '资料核查：' + source.verifiedAt); }
  }
  for (const recommendation of ai?.recommendations || []) lines.push('', '【推进建议 · ' + trackNames[recommendation.track] + '】', recommendation.advice, ...(recommendation.steps || []).map((step) => '- ' + step));
  lines.push('', '【推进顺序】', ...(plan.timeline || []).flatMap((stage) => [stage.phase + ' ' + stage.title, ...(stage.items || []).map((item) => '- ' + item)]), '', '【证据缺口】', ...(plan.missingInfo || []).map((item) => '- ' + item), '', '【材料准备清单】', ...(plan.evidenceChecklist || []).map((item) => (item.present ? '[当时填报已持有] ' : '[待准备] ') + item.label + '：' + item.reason), '', '【基础沟通函草稿】', plan.letterDraft || '');
  if (ai?.communicationDraft) lines.push('', '【沟通草稿 · 需复核】', ai.communicationDraft);
  lines.push('', '【核查提醒】', ...(plan.caution || []), '', '【当前案件跟进记录】', ...(active.notes || []).map((note) => dateTime(note.createdAt) + ' ' + note.body), '', '生成服务：' + [plan.generation?.provider, plan.generation?.model].filter(Boolean).join(' / '), '生成说明：' + (plan.generation?.reason || '按本版本案情与选中材料生成'), '金额、日期、条件及官方来源由固定规则形成，方案研判、材料识别与草稿需人工复核；生成时未进行实时法律检索。');
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
$('#note-body').addEventListener('input', () => noteDrafts.set(active?.id || 'draft', $('#note-body').value));
$('#note-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const body = $('#note-body').value.trim(); if (!body) { toast('请先填写跟进内容'); return; }
  const origin = active?.id;
  try { await queueWrite(async () => { const record = await saveDraftNow({ force: true }); const recordId = record.id; const payload = await api('/api/records/' + encodeURIComponent(recordId) + '/notes', { method: 'POST', body: { body } }); acceptRecord(payload.record); if (active?.id === recordId) { if ($('#note-body').value.trim() === body) { $('#note-body').value = ''; noteDrafts.delete(recordId); } renderCurrent(); } toast('跟进记录已保存'); }); }
  catch (error) { showError(error, origin || active?.id); }
});
$('#export-button').addEventListener('click', () => { const run = currentRun(); if (!run) return; const url = URL.createObjectURL(new Blob(['\uFEFF' + reportText()], { type: 'text/plain;charset=utf-8' })); const link = el('a'); link.href = url; link.download = '回款方案-' + active.number + '-资料v' + run.revision + '-' + run.id.slice(0, 8) + '.txt'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
$('#print-button').addEventListener('click', () => { if (!currentRun()) return; $('#print-report').textContent = reportText(); window.print(); });
window.addEventListener('beforeprint', () => { $('#print-report').textContent = reportText(); });
window.addEventListener('beforeunload', (event) => { if (dirty || pendingWrites > 0) { event.preventDefault(); event.returnValue = ''; } });
$('#history-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadHistory(), 250); });
$('#refresh-history').addEventListener('click', () => loadHistory());
$$('[data-status]').forEach((node) => node.addEventListener('click', () => { filterStatus = node.dataset.status; $$('[data-status]').forEach((item) => { item.classList.toggle('active', item === node); item.setAttribute('aria-pressed', String(item === node)); }); loadHistory(); }));
$$('[data-view]').forEach((node) => node.addEventListener('click', () => showView(node.dataset.view)));
$('.brand').addEventListener('click', (event) => { event.preventDefault(); showView('workspace'); });
$$('[data-case-tab]').forEach((node) => node.addEventListener('click', () => selectCaseTab(node.dataset.caseTab)));
$$('[data-report-tab]').forEach((node) => node.addEventListener('click', () => selectReportTab(node.dataset.reportTab)));
tabKeyboard($$('[data-case-tab]'), (node) => selectCaseTab(node.dataset.caseTab)); tabKeyboard($$('[data-report-tab]'), (node) => selectReportTab(node.dataset.reportTab));
fillForm(null); renderSources(); renderCurrent(); selectCaseTab(caseTab); checkHealth(); loadHistory({ initial: true });

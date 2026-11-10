import { RecordError } from './records.js';
import { buildOverview } from './overview-metrics.js';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const BODY_LIMIT = 64 * 1024;
const NOT_FOUND = '案件或关联台账不存在。';
const EVENT_TYPES = ['contract', 'performance', 'collection', 'promise', 'acknowledgment', 'payment', 'filing', 'acceptance', 'hearing', 'judgment', 'enforcement', 'suspension', 'other'];
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const CHINA_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: { ...HEADERS, ...extra } });
const stmt = (db, sql, ...values) => db.prepare(sql).bind(...values);
const rows = (value) => value?.results ?? [];
const changes = (value) => Number(value?.meta?.changes ?? 0);
const own = (value, key) => Object.hasOwn(value, key);

function shape(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some((key) => !allowed.includes(key))) throw new RecordError(400, '提交内容包含无效字段。');
  return value;
}
function text(value = '', max = 1000, label = '内容', required = false) {
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value) || (required && !value.trim())) throw new RecordError(400, `${label}格式无效或超过长度限制。`);
  return value.trim();
}
function identifier(value, status = 404) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new RecordError(status, status === 404 ? NOT_FOUND : '关联标识格式无效。');
  return value;
}
function choice(value, allowed, fallback, label) {
  const result = value === undefined ? fallback : value;
  if (!allowed.includes(result)) throw new RecordError(400, `${label}选项无效。`);
  return result;
}
function date(value = '', label = '日期', required = false) {
  const result = text(value, 10, label, required);
  if (!result) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new RecordError(400, `${label}须为有效日历日期。`);
  const [year, month, day] = result.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 2199 || parsed.toISOString().slice(0, 10) !== result) throw new RecordError(400, `${label}须为有效日历日期。`);
  return result;
}
function amount(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const match = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value)) : null;
  const cents = match ? BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0')) : null;
  if (cents === null || cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new RecordError(400, `${label}须为空或非负的两位小数金额。`);
  return value;
}
function requireFields(value, fields, label) {
  if (fields.some((key) => value[key] === '' || value[key] === null)) throw new RecordError(400, `${label}缺少必填金额、日期或依据。`);
}
function database(env, owner) {
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 256 || CONTROL.test(owner)) throw new RecordError(401, '请先登录后使用全局总览。');
  if (!env?.DB?.prepare || !env.DB.batch) throw new RecordError(503, '台账存储暂不可用。');
  return env.DB;
}
function chinaToday() {
  const parts = Object.fromEntries(CHINA_DATE.formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Independent snapshots: neither invoice totals nor project amounts fill financial/payment balances. */
export function validateLedgerData(value = {}) {
  shape(value, ['title', 'status', 'voidReason', 'currency', 'invoiceStatus', 'invoices', 'finance', 'payment', 'note']);
  const result = {
    title: text(value.title, 160, '台账名称') || '未命名应收台账',
    status: choice(value.status, ['active', 'voided'], 'active', '台账状态'),
    voidReason: text(value.voidReason, 2000, '作废原因'),
    currency: choice(value.currency, ['CNY'], 'CNY', '币种'),
    invoiceStatus: choice(value.invoiceStatus, ['unconfirmed', 'not_issued', 'recorded'], 'unconfirmed', '发票状态'),
    invoices: [], finance: {}, payment: {}, note: text(value.note, 4000, '台账备注'),
  };
  if (result.status === 'voided' && !result.voidReason) throw new RecordError(400, '作废台账须填写原因。');
  const invoices = value.invoices ?? [];
  if (!Array.isArray(invoices) || invoices.length > 30) throw new RecordError(400, '每项台账最多填写30条发票明细。');
  result.invoices = invoices.map((invoice) => {
    shape(invoice, ['id', 'number', 'issuedOn', 'amount', 'status', 'note']);
    const line = {
      id: invoice.id === undefined || invoice.id === '' ? crypto.randomUUID() : identifier(invoice.id, 400),
      number: text(invoice.number, 120, '发票号码'), issuedOn: date(invoice.issuedOn, '开票日期'),
      amount: amount(invoice.amount, '发票金额'), status: choice(invoice.status, ['issued', 'voided', 'red_offset'], 'issued', '发票明细状态'),
      note: text(invoice.note, 1000, '发票备注'),
    };
    if (line.status !== 'voided') requireFields(line, ['issuedOn', 'amount'], '有效发票明细');
    return line;
  });
  if (new Set(result.invoices.map((item) => item.id)).size !== result.invoices.length) throw new RecordError(400, '发票明细标识不能重复。');
  if (result.invoiceStatus === 'recorded' && !result.invoices.some((item) => item.status !== 'voided')) throw new RecordError(400, '已录入发票须包含至少一条有效明细。');
  if (result.invoiceStatus === 'not_issued' && result.invoices.some((item) => item.status !== 'voided')) throw new RecordError(400, '未开票状态不能包含已开票或红冲明细；请核对开票状态。');
  const finance = shape(value.finance ?? {}, ['status', 'recognizedOn', 'agingStartOn', 'balance', 'asOf', 'reference', 'note']);
  result.finance = {
    status: choice(finance.status, ['unconfirmed', 'confirmed', 'not_recognized'], 'unconfirmed', '财务应收状态'),
    recognizedOn: date(finance.recognizedOn, '应收确认日'), agingStartOn: date(finance.agingStartOn, '账龄起算日'),
    balance: amount(finance.balance, '财务应收余额'), asOf: date(finance.asOf, '财务余额截至日'),
    reference: text(finance.reference, 2000, '财务确认依据'), note: text(finance.note, 2000, '财务备注'),
  };
  if (result.finance.status === 'confirmed') requireFields(result.finance, ['recognizedOn', 'balance', 'asOf', 'reference'], '已确认财务应收');
  const payment = shape(value.payment ?? {}, ['status', 'unpaidAmount', 'asOf', 'originalDueOn', 'currentDueOn', 'conditions', 'basis', 'note']);
  result.payment = {
    status: choice(payment.status, ['unconfirmed', 'conditional', 'confirmed'], 'unconfirmed', '付款期限状态'),
    unpaidAmount: amount(payment.unpaidAmount, '到期口径未付金额'), asOf: date(payment.asOf, '未付金额截至日'),
    originalDueOn: date(payment.originalDueOn, '原付款日'), currentDueOn: date(payment.currentDueOn, '现付款日'),
    conditions: text(payment.conditions, 2000, '付款条件'), basis: text(payment.basis, 2000, '期限依据'), note: text(payment.note, 2000, '期限备注'),
  };
  if (result.payment.status === 'confirmed') requireFields(result.payment, ['unpaidAmount', 'asOf', 'originalDueOn', 'currentDueOn', 'basis'], '已确认付款期限');
  return result;
}

export function validateLegalEventData(value = {}, today = chinaToday()) {
  shape(value, ['type', 'eventOn', 'title', 'description', 'deliveryStatus', 'servedOn', 'evidenceNote', 'attachmentIds', 'verification', 'reviewer', 'reviewedOn', 'reminderOn', 'deadlineOn', 'deadlineBasis', 'deadlineReviewer', 'deadlineReviewedOn']);
  const result = {
    type: choice(value.type, EVENT_TYPES, 'other', '法律事件类型'), eventOn: date(value.eventOn, '事件发生日'),
    title: text(value.title, 160, '事件名称') || '未命名法律事件', description: text(value.description, 4000, '事件说明'),
    deliveryStatus: choice(value.deliveryStatus, ['unknown', 'pending', 'served', 'not_served'], 'unknown', '送达状态'),
    servedOn: date(value.servedOn, '送达日期'), evidenceNote: text(value.evidenceNote, 4000, '证据说明'),
    attachmentIds: value.attachmentIds ?? [], verification: choice(value.verification, ['pending', 'reviewed'], 'pending', '核验状态'),
    reviewer: text(value.reviewer, 120, '核验人'), reviewedOn: date(value.reviewedOn, '核验日期'), reminderOn: date(value.reminderOn, '提醒日'),
    deadlineOn: date(value.deadlineOn, '人工核定期限'), deadlineBasis: text(value.deadlineBasis, 2000, '期限依据'),
    deadlineReviewer: text(value.deadlineReviewer, 120, '期限核定人'), deadlineReviewedOn: date(value.deadlineReviewedOn, '期限核定日期'),
  };
  if (!Array.isArray(result.attachmentIds) || result.attachmentIds.length > 8 || new Set(result.attachmentIds).size !== result.attachmentIds.length) throw new RecordError(400, '事件附件标识无效。');
  result.attachmentIds = result.attachmentIds.map((id) => identifier(id, 400));
  if (result.deliveryStatus === 'served') {
    requireFields(result, ['servedOn'], '已送达事件');
    if (result.servedOn > today) throw new RecordError(400, '已送达日期不能晚于今天。');
  }
  if (result.verification === 'reviewed') requireFields(result, ['eventOn', 'reviewer', 'reviewedOn', 'evidenceNote'], '已核验事件');
  if (result.deadlineOn) requireFields(result, ['deadlineBasis', 'deadlineReviewer', 'deadlineReviewedOn'], '人工核定期限');
  return result;
}

function ledger(row) { return { id: row.id, recordId: row.record_id, revision: row.revision, data: JSON.parse(row.data_json), createdAt: row.created_at, updatedAt: row.updated_at }; }
function legalEvent(row) { return { id: row.id, recordId: row.record_id, ledgerId: row.receivable_id ?? null, supersedesId: row.supersedes_id ?? null, data: JSON.parse(row.data_json), createdAt: row.created_at }; }
function history(row) { return { id: row.id, recordId: row.record_id, ledgerId: row.receivable_id, revision: row.revision, data: JSON.parse(row.data_json), changeReason: row.change_reason, createdAt: row.created_at }; }
function safeRecord(row) {
  const input = JSON.parse(row.input_json);
  const fields = ['companyName', 'debtorName', 'amount', 'dueDate', 'contractDate', 'legalFactDate', 'arbitrationAgreementDate', 'issueText', 'projectType', 'debtorType', 'creditorSize', 'acceptanceStatus', 'disputeClause', 'disputeAccepted', 'issueTypes', 'evidence'];
  return { id: row.id, number: row.number, title: row.title, status: row.status, revision: row.revision,
    input: Object.fromEntries(Object.entries(input).filter(([key]) => fields.includes(key))), createdAt: row.created_at, updatedAt: row.updated_at };
}
async function parent(db, owner, id, active = false) {
  const row = await stmt(db, 'SELECT * FROM recovery_records WHERE owner_id = ? AND id = ?', owner, identifier(id)).first();
  if (!row) throw new RecordError(404, NOT_FOUND);
  if (active && row.status !== 'active') throw new RecordError(409, '已归档案件须恢复后才能编辑台账或法律事件。');
  return row;
}
async function getLedger(db, owner, id) {
  const row = await stmt(db, `SELECT l.* FROM recovery_receivables l WHERE l.owner_id = ? AND l.id = ?
    AND EXISTS (SELECT 1 FROM recovery_records r WHERE r.owner_id = l.owner_id AND r.id = l.record_id)`, owner, identifier(id)).first();
  if (!row) throw new RecordError(404, NOT_FOUND);
  return row;
}

export async function getOverview(env, owner, filters = {}, today = chinaToday()) {
  const db = database(env, owner);
  shape(filters, ['q', 'caseStatus', 'recordId']);
  const query = text(filters.q, 200, '搜索内容');
  const status = choice(filters.caseStatus, ['all', 'active', 'archived'], 'all', '案件状态');
  const recordId = filters.recordId ? identifier(filters.recordId) : '';
  if (recordId) await parent(db, owner, recordId);
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  // Every owner row participates. There is intentionally no page-size cap on a global summary.
  const result = await db.batch([
    stmt(db, `SELECT r.* FROM recovery_records r WHERE r.owner_id = ? AND (? = 'all' OR r.status = ?)
      AND (? = '' OR r.id = ?) AND (? = '' OR r.title LIKE ? ESCAPE '\\' OR r.number LIKE ? ESCAPE '\\'
      OR json_extract(r.input_json, '$.debtorName') LIKE ? ESCAPE '\\' OR json_extract(r.input_json, '$.companyName') LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM recovery_receivables l WHERE l.owner_id = r.owner_id AND l.record_id = r.id AND json_extract(l.data_json, '$.title') LIKE ? ESCAPE '\\'))
      ORDER BY r.updated_at DESC, r.id DESC`, owner, status, status, recordId, recordId, query, pattern, pattern, pattern, pattern, pattern),
    stmt(db, 'SELECT * FROM recovery_receivables WHERE owner_id = ? ORDER BY updated_at DESC, id DESC', owner),
    stmt(db, 'SELECT * FROM recovery_legal_events WHERE owner_id = ? ORDER BY created_at, id', owner),
    stmt(db, 'SELECT id, record_id, body, created_at FROM recovery_notes WHERE owner_id = ? ORDER BY created_at, id', owner),
  ]);
  const recordRows = rows(result[0]);
  const ids = new Set(recordRows.map((row) => row.id));
  const notes = new Map();
  for (const row of rows(result[3])) {
    if (!ids.has(row.record_id)) continue;
    if (!notes.has(row.record_id)) notes.set(row.record_id, []);
    notes.get(row.record_id).push({ id: row.id, recordId: row.record_id, body: row.body, createdAt: row.created_at });
  }
  const records = recordRows.map((row) => ({ ...safeRecord(row), notes: notes.get(row.id) ?? [] }));
  return buildOverview({ records, ledgers: rows(result[1]).filter((row) => ids.has(row.record_id)).map(ledger), legalEvents: rows(result[2]).filter((row) => ids.has(row.record_id)).map(legalEvent) }, date(today, '统计日期', true));
}

export async function createLedger(env, owner, value) {
  const db = database(env, owner);
  shape(value, ['recordId', 'data']);
  const id = identifier(value.recordId);
  await parent(db, owner, id, true);
  const data = JSON.stringify(validateLedgerData(value.data));
  const ledgerId = crypto.randomUUID(); const historyId = crypto.randomUUID(); const now = new Date().toISOString();
  const result = await db.batch([
    stmt(db, `INSERT INTO recovery_receivables (id, owner_id, record_id, revision, data_json, created_at, updated_at)
      SELECT ?, r.owner_id, r.id, 1, ?, ?, ? FROM recovery_records r WHERE r.owner_id = ? AND r.id = ? AND r.status = 'active'`, ledgerId, data, now, now, owner, id),
    stmt(db, `INSERT INTO recovery_receivable_history (id, owner_id, record_id, receivable_id, revision, data_json, change_reason, created_at)
      SELECT ?, owner_id, record_id, id, revision, data_json, '创建台账', ? FROM recovery_receivables WHERE owner_id = ? AND record_id = ? AND id = ?`, historyId, now, owner, id, ledgerId),
  ]);
  if (!changes(result[0])) { await parent(db, owner, id, true); throw new RecordError(409, '台账未保存，请重试。'); }
  return ledger(await getLedger(db, owner, ledgerId));
}

export async function updateLedger(env, owner, id, value) {
  const db = database(env, owner);
  shape(value, ['revision', 'data', 'changeReason']);
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new RecordError(400, '请提供有效台账版本号。');
  const current = await getLedger(db, owner, id);
  await parent(db, owner, current.record_id, true);
  if (current.revision !== value.revision) throw new RecordError(409, '台账已被更新，请重新加载。');
  if (!own(value, 'data')) throw new RecordError(400, '请提供台账资料。');
  const next = validateLedgerData(value.data);
  const reason = text(value.changeReason, 2000, '修改原因');
  const before = JSON.parse(current.data_json);
  if (before.payment.originalDueOn && before.payment.originalDueOn !== next.payment.originalDueOn && !reason) throw new RecordError(400, '更正已保存的原付款日须填写修改原因。');
  const data = JSON.stringify(next); const historyId = crypto.randomUUID(); const now = new Date().toISOString();
  // Insert the new immutable revision only if its prior version is still current.
  // The guarded UPDATE and history INSERT execute within the same D1 transaction.
  const result = await db.batch([
    stmt(db, `INSERT INTO recovery_receivable_history (id, owner_id, record_id, receivable_id, revision, data_json, change_reason, created_at)
      SELECT ?, l.owner_id, l.record_id, l.id, l.revision + 1, ?, ?, ? FROM recovery_receivables l
      WHERE l.owner_id = ? AND l.id = ? AND l.revision = ?
      AND EXISTS (SELECT 1 FROM recovery_records r WHERE r.owner_id = l.owner_id AND r.id = l.record_id AND r.status = 'active')`, historyId, data, reason, now, owner, id, value.revision),
    stmt(db, `UPDATE recovery_receivables SET data_json = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ? AND revision = ?
      AND EXISTS (SELECT 1 FROM recovery_receivable_history h WHERE h.owner_id = ? AND h.receivable_id = ? AND h.id = ?)`, data, now, owner, id, value.revision, owner, id, historyId),
  ]);
  if (!changes(result[1])) { await parent(db, owner, current.record_id, true); throw new RecordError(409, '台账已被更新，请重新加载。'); }
  return ledger(await getLedger(db, owner, id));
}

export async function getLedgerHistory(env, owner, id) {
  const db = database(env, owner);
  const current = await getLedger(db, owner, id);
  return rows(await stmt(db, `SELECT * FROM recovery_receivable_history WHERE owner_id = ? AND record_id = ? AND receivable_id = ? ORDER BY revision DESC`, owner, current.record_id, id).all()).map(history);
}

export async function createLegalEvent(env, owner, value, today = chinaToday()) {
  const db = database(env, owner);
  shape(value, ['recordId', 'ledgerId', 'supersedesId', 'data']);
  const recordId = identifier(value.recordId);
  await parent(db, owner, recordId, true);
  const ledgerId = value.ledgerId == null || value.ledgerId === '' ? null : identifier(value.ledgerId);
  const supersedesId = value.supersedesId == null || value.supersedesId === '' ? null : identifier(value.supersedesId);
  if (ledgerId && (await getLedger(db, owner, ledgerId)).record_id !== recordId) throw new RecordError(404, NOT_FOUND);
  if (supersedesId) {
    const previous = await stmt(db, 'SELECT * FROM recovery_legal_events WHERE owner_id = ? AND record_id = ? AND id = ?', owner, recordId, supersedesId).first();
    if (!previous || (previous.receivable_id ?? null) !== ledgerId) throw new RecordError(404, NOT_FOUND);
    if (await stmt(db, 'SELECT id FROM recovery_legal_events WHERE owner_id = ? AND supersedes_id = ?', owner, supersedesId).first()) throw new RecordError(409, '该事件已有更正，请对最新版本继续更正。');
  }
  const data = validateLegalEventData(value.data, date(today, '当前日期', true));
  const ids = data.attachmentIds;
  const attachmentCondition = ids.length ? `AND (SELECT count(*) FROM recovery_attachments a WHERE a.owner_id = r.owner_id AND a.record_id = r.id AND a.removed_at IS NULL AND a.id IN (${ids.map(() => '?').join(', ')})) = ?` : '';
  const correctionCondition = supersedesId ? `AND EXISTS (SELECT 1 FROM recovery_legal_events e WHERE e.owner_id = r.owner_id AND e.record_id = r.id AND e.id = ? AND e.receivable_id IS ?)
    AND NOT EXISTS (SELECT 1 FROM recovery_legal_events e WHERE e.owner_id = r.owner_id AND e.supersedes_id = ?)` : '';
  const ledgerCondition = ledgerId ? 'AND EXISTS (SELECT 1 FROM recovery_receivables l WHERE l.owner_id = r.owner_id AND l.record_id = r.id AND l.id = ?)' : '';
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  const result = await stmt(db, `INSERT INTO recovery_legal_events (id, owner_id, record_id, receivable_id, supersedes_id, data_json, created_at)
    SELECT ?, r.owner_id, r.id, ?, ?, ?, ? FROM recovery_records r WHERE r.owner_id = ? AND r.id = ? AND r.status = 'active'
    ${ledgerCondition} ${correctionCondition} ${attachmentCondition}`,
  id, ledgerId, supersedesId, JSON.stringify(data), now, owner, recordId, ...(ledgerId ? [ledgerId] : []), ...(supersedesId ? [supersedesId, ledgerId, supersedesId] : []), ...(ids.length ? [...ids, ids.length] : [])).run();
  if (!changes(result)) {
    await parent(db, owner, recordId, true);
    if (supersedesId && await stmt(db, 'SELECT id FROM recovery_legal_events WHERE owner_id = ? AND supersedes_id = ?', owner, supersedesId).first()) throw new RecordError(409, '该事件已有更正，请重新加载。');
    throw new RecordError(404, '事件关联的台账或有效附件不存在。');
  }
  return legalEvent(await stmt(db, 'SELECT * FROM recovery_legal_events WHERE owner_id = ? AND record_id = ? AND id = ?', owner, recordId, id).first());
}

async function readJSON(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new RecordError(400, '请使用 JSON 格式提交。');
  const length = request.headers.get('Content-Length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > BODY_LIMIT) throw new RecordError(413, '提交内容超过大小限制。');
  if (!request.body) throw new RecordError(400, '提交内容为空。');
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > BODY_LIMIT) { await reader.cancel(); throw new RecordError(413, '提交内容超过大小限制。'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RecordError(400, '提交内容格式无效。'); }
}

/** Authentication uses a server-owned local identity or the trusted platform header. */
export async function handleOverviewAPI(request, env, options = {}) {
  const owner = options.localOwnerId || request.headers.get('oai-authenticated-user-id');
  try {
    database(env, owner);
    const url = new URL(request.url);
    let path;
    try { path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
    catch { throw new RecordError(400, '接口路径格式无效。'); }
    if (path[0] !== 'api' || path[1] !== 'overview') throw new RecordError(404, '接口不存在。');
    if (path.length === 2) {
      if (request.method === 'GET') return json(await getOverview(env, owner, { q: url.searchParams.get('q') ?? '', caseStatus: url.searchParams.get('caseStatus') || 'all', recordId: url.searchParams.get('recordId') || '' }, options.today || chinaToday()));
      return json({ error: '请求方法不支持。' }, 405, { Allow: 'GET' });
    }
    if (path.length === 3 && path[2] === 'records' && request.method === 'GET') {
      const records = rows(await stmt(env.DB, 'SELECT * FROM recovery_records WHERE owner_id = ? ORDER BY updated_at DESC, id DESC', owner).all()).map(safeRecord);
      return json({ records });
    }
    if (path[2] === 'ledgers') {
      if (path.length === 3 && request.method === 'POST') return json({ ledger: await createLedger(env, owner, await readJSON(request)) }, 201);
      if (path.length === 4 && request.method === 'PATCH') return json({ ledger: await updateLedger(env, owner, path[3], await readJSON(request)) });
      if (path.length === 5 && path[4] === 'history' && request.method === 'GET') return json({ history: await getLedgerHistory(env, owner, path[3]) });
    }
    if (path.length === 3 && path[2] === 'legal-events' && request.method === 'POST') return json({ legalEvent: await createLegalEvent(env, owner, await readJSON(request), options.today || chinaToday()) }, 201);
    throw new RecordError(404, '接口不存在或方法不支持。');
  } catch (error) {
    if (error instanceof RecordError) return json({ error: error.message }, error.status);
    return json({ error: '总览操作暂未完成，请稍后重试。' }, 500);
  }
}

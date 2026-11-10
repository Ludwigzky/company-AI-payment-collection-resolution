/** D1-backed recovery cases. Migrations, never request handlers, create tables. */
export class RecordError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RecordError';
    this.status = status;
  }
}

export const ATTACHMENT_LIMITS = Object.freeze({ count: 8, fileBytes: 5 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 });
const NOT_FOUND = '案件或关联资料不存在。';
const INPUT_CHOICES = Object.freeze({
  projectType: ['equipment', 'general', 'construction'],
  debtorType: ['enterprise', 'large', 'government', 'institution'],
  creditorSize: ['unknown', 'sme', 'large'],
  acceptanceStatus: ['unknown', 'passed', 'pending', 'disputed'],
  disputeClause: ['unknown', 'court', 'arbitration'],
  disputeAccepted: ['unknown', 'no', 'yes'],
});
const INPUT_ARRAYS = Object.freeze({
  issueTypes: ['repair', 'acceptance', 'invoice', 'cashflow', 'dispute', 'unresponsive'],
  evidence: ['contract', 'delivery', 'acceptance', 'invoice', 'reconciliation', 'collection', 'repair'],
});
const INPUT_FIELDS = new Set(['companyName', 'debtorName', 'amount', 'dueDate', 'contractDate', 'legalFactDate', 'arbitrationAgreementDate', 'issueText', ...Object.keys(INPUT_CHOICES), ...Object.keys(INPUT_ARRAYS)]);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CHINA_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function shape(value, fields) {
  if (!plainObject(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new RecordError(400, '提交的数据包含无效字段。');
  }
  return value;
}

function string(value, max, label, { empty = true } = {}) {
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value) || (!empty && !value.trim())) {
    throw new RecordError(400, `${label}格式无效或超过长度限制。`);
  }
  return value;
}

function database(env, owner) {
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 256 || CONTROL.test(owner)) {
    throw new RecordError(401, '请先登录后再使用案件功能。');
  }
  if (!env?.DB?.prepare || !env.DB.batch) throw new RecordError(503, '案件存储暂不可用。');
  return env.DB;
}

function recordId(value) {
  if (typeof value !== 'string' || !value || value.length > 100 || CONTROL.test(value)) throw new RecordError(404, NOT_FOUND);
  return value;
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RecordError(400, '请提供有效的案件版本号。');
  return value;
}

/** Draft validation permits incomplete fields; analysis applies stricter rules. */
export function validateRecordInput(value = {}) {
  if (!plainObject(value) || Object.keys(value).some((key) => !INPUT_FIELDS.has(key))) {
    throw new RecordError(400, '项目资料包含无效字段。');
  }
  const result = {};
  for (const key of ['companyName', 'debtorName', 'issueText']) {
    if (value[key] !== undefined) result[key] = string(value[key], key === 'issueText' ? 6000 : 200, '项目资料');
  }
  if (value.amount !== undefined) {
    if (value.amount !== null && value.amount !== '' && (typeof value.amount !== 'number' || !Number.isFinite(value.amount))) {
      throw new RecordError(400, '草稿金额须为空或有效数字。');
    }
    result.amount = value.amount;
  }
  for (const field of ['dueDate', 'contractDate', 'legalFactDate', 'arbitrationAgreementDate']) {
    if (value[field] === undefined) continue;
    const date = string(value[field], 10, '项目相关日期');
    if (date !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RecordError(400, '项目相关日期格式无效。');
      const [year, month, day] = date.split('-').map(Number);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      if (year < 1900 || year > 2199 || parsed.toISOString().slice(0, 10) !== date) throw new RecordError(400, '项目相关日期格式无效。');
    }
    result[field] = date;
  }
  for (const [key, choices] of Object.entries(INPUT_CHOICES)) {
    if (value[key] === undefined) continue;
    if (value[key] !== '' && !choices.includes(value[key])) throw new RecordError(400, '项目选项无效。');
    result[key] = value[key];
  }
  for (const [key, choices] of Object.entries(INPUT_ARRAYS)) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].length > choices.length || value[key].some((item) => !choices.includes(item))) {
      throw new RecordError(400, '项目问题或材料选项无效。');
    }
    result[key] = [...new Set(value[key])];
  }
  return result;
}

function title(value = '') { return string(value, 120, '案件名称').trim() || '未命名回款案件'; }
function stmt(db, sql, ...values) { return db.prepare(sql).bind(...values); }
function changes(result) { return Number(result?.meta?.changes ?? 0); }
function rows(result) { return result?.results ?? []; }

function attachment(row, includeKey = false) {
  return {
    id: row.id, recordId: row.record_id, name: row.name, mime: row.mime, size: row.size,
    sha256: row.sha256, ...(includeKey ? { objectKey: row.object_key } : {}), createdAt: row.created_at,
  };
}

function run(row, currentRevision = row.revision) {
  return {
    id: row.id, recordId: row.record_id, revision: row.revision,
    inputSnapshot: JSON.parse(row.input_json), attachmentIds: JSON.parse(row.attachment_ids_json),
    plan: withoutStorageKeys(JSON.parse(row.plan_json)), materialSummary: withoutStorageKeys(JSON.parse(row.material_summary_json)),
    snapshotStale: Boolean(row.snapshot_stale) || row.revision < currentRevision, createdAt: row.created_at,
  };
}

function note(row) { return { id: row.id, recordId: row.record_id, body: row.body, createdAt: row.created_at }; }

/** Defense in depth for callers serializing an internally enriched record. */
export function serializeRecord(value) {
  return withoutStorageKeys(value);
}

function withoutStorageKeys(value) {
  if (Array.isArray(value)) return value.map(withoutStorageKeys);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['objectKey', 'object_key'].includes(key))
    .map(([key, item]) => [key, withoutStorageKeys(item)]));
}

async function parent(db, owner, id, { active = false } = {}) {
  const value = await stmt(db, 'SELECT * FROM recovery_records WHERE owner_id = ? AND id = ?', owner, id).first();
  if (!value || (active && value.status !== 'active')) throw new RecordError(404, NOT_FOUND);
  return value;
}

export async function listRecords(env, owner, options = {}) {
  const db = database(env, owner);
  const { query = '', status = 'all' } = shape(options, ['query', 'status']);
  string(query, 200, '搜索内容');
  if (!['all', 'active', 'archived'].includes(status)) throw new RecordError(400, '案件状态无效。');
  const search = query.trim();
  const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  // A listing is owner-scoped; every correlated child lookup additionally uses its parent record ID.
  const result = await stmt(db, `SELECT r.*,
    (SELECT count(*) FROM recovery_attachments a WHERE a.owner_id = r.owner_id AND a.record_id = r.id AND a.removed_at IS NULL) AS attachment_count,
    (SELECT count(*) FROM recovery_runs h WHERE h.owner_id = r.owner_id AND h.record_id = r.id) AS run_count
    FROM recovery_records r WHERE r.owner_id = ? AND (? = 'all' OR r.status = ?)
    AND (? = '' OR r.title LIKE ? ESCAPE '\\' OR r.number LIKE ? ESCAPE '\\'
      OR json_extract(r.input_json, '$.debtorName') LIKE ? ESCAPE '\\'
      OR json_extract(r.input_json, '$.companyName') LIKE ? ESCAPE '\\')
    ORDER BY r.updated_at DESC, r.id DESC`, owner, status, status, search, pattern, pattern, pattern, pattern).all();
  return rows(result).map((row) => {
    const input = JSON.parse(row.input_json);
    return {
      id: row.id, number: row.number, title: row.title, status: row.status, revision: row.revision,
      debtorName: input.debtorName ?? '', amount: input.amount ?? null, dueDate: input.dueDate ?? '',
      attachmentCount: row.attachment_count, runCount: row.run_count, updatedAt: row.updated_at,
    };
  });
}

export async function createRecord(env, owner, options = {}) {
  const db = database(env, owner);
  shape(options, ['title', 'input']);
  const input = validateRecordInput(options.input);
  const id = crypto.randomUUID();
  const date = new Date();
  const now = date.toISOString();
  const parts = Object.fromEntries(CHINA_DATE.formatToParts(date).map(({ type, value }) => [type, value]));
  const number = `RC-${parts.year}${parts.month}${parts.day}-${id.slice(0, 8).toUpperCase()}`;
  await stmt(db, `INSERT INTO recovery_records (id, owner_id, number, title, status, revision, input_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?)`, id, owner, number, title(options.title), JSON.stringify(input), now, now).run();
  return getRecord(env, owner, id);
}

export async function getRecord(env, owner, id) {
  const db = database(env, owner);
  recordId(id);
  // D1 batch provides one consistent snapshot for the record and its related rows.
  const result = await db.batch([
    stmt(db, 'SELECT * FROM recovery_records WHERE owner_id = ? AND id = ?', owner, id),
    stmt(db, 'SELECT * FROM recovery_attachments WHERE owner_id = ? AND record_id = ? AND removed_at IS NULL ORDER BY created_at, id', owner, id),
    stmt(db, 'SELECT * FROM recovery_runs WHERE owner_id = ? AND record_id = ? ORDER BY created_at DESC, id DESC', owner, id),
    stmt(db, 'SELECT * FROM recovery_notes WHERE owner_id = ? AND record_id = ? ORDER BY created_at DESC, id DESC', owner, id),
  ]);
  const row = rows(result[0])[0];
  if (!row) throw new RecordError(404, NOT_FOUND);
  return {
    id: row.id, number: row.number, title: row.title, status: row.status, revision: row.revision,
    input: JSON.parse(row.input_json), createdAt: row.created_at, updatedAt: row.updated_at,
    attachments: rows(result[1]).map((item) => attachment(item)),
    runs: rows(result[2]).map((item) => run(item, row.revision)), notes: rows(result[3]).map(note),
  };
}

export async function updateRecord(env, owner, id, patch) {
  const db = database(env, owner);
  recordId(id);
  shape(patch, ['revision', 'title', 'input', 'status']);
  revision(patch.revision);
  if (!['title', 'input', 'status'].some((key) => Object.hasOwn(patch, key))) throw new RecordError(400, '请提供需要更新的案件资料。');
  const hasTitle = Object.hasOwn(patch, 'title');
  const hasInput = Object.hasOwn(patch, 'input');
  const hasStatus = Object.hasOwn(patch, 'status');
  const nextTitle = hasTitle ? title(patch.title) : '';
  const input = hasInput ? JSON.stringify(validateRecordInput(patch.input)) : '{}';
  if (hasStatus && !['active', 'archived'].includes(patch.status)) throw new RecordError(400, '案件状态无效。');
  const result = await stmt(db, `UPDATE recovery_records SET
    title = CASE WHEN ? THEN ? ELSE title END,
    input_json = CASE WHEN ? THEN ? ELSE input_json END,
    status = CASE WHEN ? THEN ? ELSE status END,
    revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ? AND revision = ?`,
  Number(hasTitle), nextTitle, Number(hasInput), input, Number(hasStatus), patch.status ?? 'active',
  new Date().toISOString(), owner, id, patch.revision).run();
  if (!changes(result)) {
    await parent(db, owner, id);
    throw new RecordError(409, '案件已被更新，请重新加载后再保存。');
  }
  return getRecord(env, owner, id);
}

export async function addAttachment(env, owner, id, value) {
  const db = database(env, owner);
  recordId(id);
  shape(value, ['name', 'mime', 'size', 'sha256', 'objectKey']);
  const name = string(value.name, 255, '文件名称', { empty: false });
  const mime = string(value.mime, 150, '文件类型', { empty: false });
  const objectKey = string(value.objectKey, 1024, '文件存储标识', { empty: false });
  if (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > ATTACHMENT_LIMITS.fileBytes) throw new RecordError(413, '单个附件须大于0且不超过5MiB。');
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)) throw new RecordError(400, '文件校验值无效。');
  const attachmentId = crypto.randomUUID();
  const now = new Date().toISOString();
  // The conditional insert and version update are one atomic D1 transaction.
  // Concurrent uploads cannot both observe and consume the same quota slot.
  const result = await db.batch([
    stmt(db, `INSERT INTO recovery_attachments (id, owner_id, record_id, name, mime, size, sha256, object_key, created_at)
      SELECT ?, r.owner_id, r.id, ?, ?, ?, ?, ?, ? FROM recovery_records r
      WHERE r.owner_id = ? AND r.id = ? AND r.status = 'active'
      AND (SELECT count(*) FROM recovery_attachments a WHERE a.owner_id = r.owner_id AND a.record_id = r.id AND a.removed_at IS NULL) < ?
      AND (SELECT coalesce(sum(a.size), 0) FROM recovery_attachments a WHERE a.owner_id = r.owner_id AND a.record_id = r.id AND a.removed_at IS NULL) + ? <= ?`,
    attachmentId, name, mime, value.size, value.sha256.toLowerCase(), objectKey, now, owner, id, ATTACHMENT_LIMITS.count, value.size, ATTACHMENT_LIMITS.totalBytes),
    stmt(db, `UPDATE recovery_records SET revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?
      AND EXISTS (SELECT 1 FROM recovery_attachments a WHERE a.owner_id = ? AND a.record_id = ? AND a.id = ?)`,
    now, owner, id, owner, id, attachmentId),
  ]);
  if (!changes(result[0])) {
    await parent(db, owner, id, { active: true });
    throw new RecordError(413, '每个案件最多8个附件，附件总大小不得超过16MiB。');
  }
  return { id: attachmentId, recordId: id, name, mime, size: value.size, sha256: value.sha256.toLowerCase(), createdAt: now };
}

/** Only this server-side download lookup exposes the private R2 object key. */
export async function getAttachment(env, owner, id, attachmentId) {
  const db = database(env, owner);
  recordId(id);
  recordId(attachmentId);
  const value = await stmt(db, `SELECT a.* FROM recovery_attachments a
    WHERE a.owner_id = ? AND a.record_id = ? AND a.id = ? AND a.removed_at IS NULL
    AND EXISTS (SELECT 1 FROM recovery_records r WHERE r.owner_id = ? AND r.id = ?)`, owner, id, attachmentId, owner, id).first();
  if (!value) throw new RecordError(404, NOT_FOUND);
  return attachment(value, true);
}

export async function removeAttachment(env, owner, id, attachmentId) {
  const db = database(env, owner);
  recordId(id);
  recordId(attachmentId);
  const now = new Date().toISOString();
  // Update the parent first while the attachment is still active. The entire
  // batch is atomic, including the soft removal, so repeat removal cannot bump revision.
  const result = await db.batch([
    stmt(db, `UPDATE recovery_records SET revision = revision + 1, updated_at = ?
      WHERE owner_id = ? AND id = ? AND status = 'active'
      AND EXISTS (SELECT 1 FROM recovery_attachments a WHERE a.owner_id = ? AND a.record_id = ? AND a.id = ? AND a.removed_at IS NULL)`,
    now, owner, id, owner, id, attachmentId),
    stmt(db, `UPDATE recovery_attachments SET removed_at = ? WHERE owner_id = ? AND record_id = ? AND id = ? AND removed_at IS NULL
      AND EXISTS (SELECT 1 FROM recovery_records r WHERE r.owner_id = ? AND r.id = ? AND r.status = 'active')`,
    now, owner, id, attachmentId, owner, id),
  ]);
  if (!changes(result[0])) throw new RecordError(404, NOT_FOUND);
  return getRecord(env, owner, id);
}

function jsonValue(value, label, maxBytes) {
  function inspect(item, depth = 0) {
    if (depth > 25) throw new RecordError(400, `${label}层级过深。`);
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
    if (Array.isArray(item)) { item.forEach((child) => inspect(child, depth + 1)); return; }
    if (plainObject(item)) { Object.values(item).forEach((child) => inspect(child, depth + 1)); return; }
    throw new RecordError(400, `${label}数据无效。`);
  }
  inspect(value);
  const result = JSON.stringify(value);
  if (new TextEncoder().encode(result).byteLength > maxBytes) throw new RecordError(413, `${label}内容过大。`);
  return result;
}

export async function saveRun(env, owner, id, value) {
  const db = database(env, owner);
  recordId(id);
  shape(value, ['revision', 'inputSnapshot', 'attachmentIds', 'plan', 'materialSummary']);
  revision(value.revision);
  if (!Object.hasOwn(value, 'inputSnapshot')) throw new RecordError(400, '请提供生成时的项目资料快照。');
  const input = JSON.stringify(validateRecordInput(value.inputSnapshot));
  if (!Array.isArray(value.attachmentIds) || value.attachmentIds.length > ATTACHMENT_LIMITS.count
    || new Set(value.attachmentIds).size !== value.attachmentIds.length) throw new RecordError(400, '生成所用附件标识无效。');
  value.attachmentIds.forEach(recordId);
  if (!plainObject(value.plan)) throw new RecordError(400, '方案数据无效。');
  const plan = jsonValue(value.plan, '方案', 512 * 1024);
  const summary = jsonValue(value.materialSummary ?? null, '材料摘要', 128 * 1024);
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const ids = [...value.attachmentIds];
  // Removed metadata remains addressable for an in-flight generation snapshot.
  // Ownership is still checked for every attachment, including removed ones.
  const attachmentCondition = ids.length
    ? `AND (SELECT count(*) FROM recovery_attachments a WHERE a.owner_id = ? AND a.record_id = ? AND a.id IN (${ids.map(() => '?').join(', ')})) = ?`
    : '';
  const attachmentParameters = ids.length ? [owner, id, ...ids, ids.length] : [];
  // The API requires active status when generation starts. An in-flight result
  // may finish after archiving and is appended without restoring or editing its parent.
  const result = await db.batch([
    stmt(db, `INSERT INTO recovery_runs (id, owner_id, record_id, revision, input_json, attachment_ids_json, plan_json, material_summary_json, snapshot_stale, created_at)
      SELECT ?, r.owner_id, r.id, ?, ?, ?, ?, ?, CASE WHEN r.revision > ? THEN 1 ELSE 0 END, ?
      FROM recovery_records r WHERE r.owner_id = ? AND r.id = ? AND r.revision >= ? ${attachmentCondition}`,
    runId, value.revision, input, JSON.stringify(ids), plan, summary, value.revision, now, owner, id, value.revision, ...attachmentParameters),
    stmt(db, `UPDATE recovery_records SET updated_at = ? WHERE owner_id = ? AND id = ?
      AND EXISTS (SELECT 1 FROM recovery_runs h WHERE h.owner_id = ? AND h.record_id = ? AND h.id = ?)`,
    now, owner, id, owner, id, runId),
  ]);
  if (!changes(result[0])) {
    const current = await parent(db, owner, id);
    if (value.revision > current.revision) throw new RecordError(409, '生成快照版本无效，请重新加载案件。');
    throw new RecordError(404, NOT_FOUND);
  }
  const [saved, current] = await Promise.all([
    stmt(db, 'SELECT * FROM recovery_runs WHERE owner_id = ? AND record_id = ? AND id = ?', owner, id, runId).first(),
    parent(db, owner, id),
  ]);
  return run(saved, current.revision);
}

export async function addNote(env, owner, id, value) {
  const db = database(env, owner);
  recordId(id);
  shape(value, ['body']);
  const body = string(value.body, 4000, '跟进记录', { empty: false }).trim();
  const noteId = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = await db.batch([
    stmt(db, `INSERT INTO recovery_notes (id, owner_id, record_id, body, created_at)
      SELECT ?, r.owner_id, r.id, ?, ? FROM recovery_records r WHERE r.owner_id = ? AND r.id = ? AND r.status = 'active'`, noteId, body, now, owner, id),
    stmt(db, `UPDATE recovery_records SET updated_at = ? WHERE owner_id = ? AND id = ?
      AND EXISTS (SELECT 1 FROM recovery_notes n WHERE n.owner_id = ? AND n.record_id = ? AND n.id = ?)`, now, owner, id, owner, id, noteId),
  ]);
  if (!changes(result[0])) throw new RecordError(404, NOT_FOUND);
  return note(await stmt(db, 'SELECT * FROM recovery_notes WHERE owner_id = ? AND record_id = ? AND id = ?', owner, id, noteId).first());
}

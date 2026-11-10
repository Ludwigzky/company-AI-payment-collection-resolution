import { generateAIPlan, InputError } from './ai.js';
import { validateMaterial, prepareMaterials, MaterialError } from './materials.js';
import { RecordError, ATTACHMENT_LIMITS, listRecords, createRecord, getRecord, updateRecord, addAttachment, getAttachment, removeAttachment, saveRun, addNote } from './records.js';

const JSON_LIMIT = 32 * 1024;
const UPLOAD_LIMIT = ATTACHMENT_LIMITS.fileBytes + 64 * 1024;
const activeAnalyses = new Set();
const responseHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function json(value, status = 200, extra = {}) { return new Response(JSON.stringify(value), { status, headers: { ...responseHeaders, ...extra } }); }

async function bytes(request, limit) {
  const length = request.headers.get('Content-Length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > limit) throw new RecordError(413, '提交内容超过大小限制。');
  if (!request.body) throw new RecordError(400, '提交内容为空。');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new RecordError(413, '提交内容超过大小限制。'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function readJSON(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new RecordError(400, '请使用 JSON 格式提交。');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bytes(request, JSON_LIMIT))); }
  catch (error) { if (error instanceof RecordError) throw error; throw new RecordError(400, '提交内容格式无效。'); }
}

function shape(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new RecordError(400, '提交内容包含无效字段。');
  return value;
}

function requireStorage(env) {
  if (!env.DB?.prepare || !env.BUCKET?.put || !env.BUCKET?.get) throw new RecordError(503, '案件归档服务尚未就绪，请稍后重试。');
}

async function upload(request, env, owner, recordId) {
  const current = await getRecord(env, owner, recordId);
  if (current.status !== 'active') throw new RecordError(409, '已归档案件需恢复后才能上传。');
  if (current.attachments.length >= ATTACHMENT_LIMITS.count) throw new RecordError(413, '每个案件最多8个附件。');
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) throw new RecordError(400, '请以文件上传方式提交附件。');
  let form;
  try { form = await new Response(await bytes(request, UPLOAD_LIMIT), { headers: { 'Content-Type': contentType } }).formData(); }
  catch (error) { if (error instanceof RecordError) throw error; throw new RecordError(400, '附件上传格式无效。'); }
  const fields = [...form.entries()];
  if (fields.length !== 1 || fields[0][0] !== 'file' || typeof fields[0][1] === 'string') throw new RecordError(400, '每次请上传一个文件。');
  const file = fields[0][1];
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const material = await validateMaterial({ name: file.name, mime: file.type, bytes: fileBytes });
  if (current.attachments.reduce((sum, item) => sum + item.size, 0) + material.size > ATTACHMENT_LIMITS.totalBytes) throw new RecordError(413, '本案件附件总大小不得超过16MiB。');
  const ownerHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(owner)))].map((value) => value.toString(16).padStart(2, '0')).join('');
  const objectKey = `${ownerHash}/${recordId}/${crypto.randomUUID()}`;
  await env.BUCKET.put(objectKey, fileBytes, { httpMetadata: { contentType: material.mime } });
  let attachment;
  try { attachment = await addAttachment(env, owner, recordId, { name: material.name, mime: material.mime, size: material.size, sha256: material.sha256, objectKey }); }
  catch (error) {
    // A lost D1 acknowledgement can follow a successful commit. Preserve the
    // object after an uncertain failure so an already-linked file is not lost.
    const definitelyUnlinked = error instanceof RecordError && [400, 404, 413].includes(error.status);
    if (definitelyUnlinked && env.BUCKET.delete) { try { await env.BUCKET.delete(objectKey); } catch {} }
    throw error;
  }
  return json({ attachment, record: await getRecord(env, owner, recordId) }, 201);
}

async function download(request, env, owner, recordId, attachmentId) {
  const attachment = await getAttachment(env, owner, recordId, attachmentId);
  const object = await env.BUCKET.get(attachment.objectKey);
  if (!object) throw new RecordError(404, '附件文件暂不可用。');
  const inline = attachment.mime.startsWith('image/') && new URL(request.url).searchParams.get('download') !== '1';
  const safeName = attachment.name.replace(/[\r\n]/g, '');
  return new Response(object.body, { headers: {
    'Content-Type': attachment.mime,
    'Content-Length': String(attachment.size),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}

async function analyze(request, env, owner, recordId, options) {
  const body = shape(await readJSON(request), ['revision', 'attachmentIds']);
  const current = await getRecord(env, owner, recordId);
  if (current.status !== 'active') throw new RecordError(409, '已归档案件需恢复后才能重新生成方案。');
  if (!Number.isSafeInteger(body.revision) || body.revision !== current.revision) throw new RecordError(409, '案件资料已更新，请重新加载后再生成。');
  const ids = body.attachmentIds ?? current.attachments.map((item) => item.id);
  if (!Array.isArray(ids) || ids.length > ATTACHMENT_LIMITS.count || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string')) throw new RecordError(400, '选择的附件无效。');
  // Resolve all IDs against the owned parent before reading any storage bytes.
  const owned = [];
  for (const id of ids) owned.push(await getAttachment(env, owner, recordId, id));
  if (owned.reduce((sum, item) => sum + item.size, 0) > 12 * 1024 * 1024) throw new RecordError(413, '本次分析选中的附件超过12MiB，请减少选中文件。');
  const lock = `${owner}\u0000${recordId}`;
  if (activeAnalyses.has(lock)) throw new RecordError(409, '本案件已有方案正在生成，请等待完成。');
  activeAnalyses.add(lock);
  try {
    const items = [];
    for (const attachment of owned) {
      const object = await env.BUCKET.get(attachment.objectKey);
      if (!object) throw new RecordError(404, '选中附件暂不可读取，请检查资料后重试。');
      const data = new Uint8Array(await object.arrayBuffer());
      if (data.byteLength !== attachment.size) throw new RecordError(409, '附件存储校验失败，请重新上传。');
      items.push({ id: attachment.id, caseId: recordId, name: attachment.name, mime: attachment.mime, bytes: data });
    }
    const materialsContext = await prepareMaterials(items, { caseId: recordId });
    if (materialsContext.summary.some((item) => owned.find((attachment) => attachment.id === item.id)?.sha256 !== item.sha256)) throw new RecordError(409, '附件校验值不一致，请重新上传资料。');
    const plan = await generateAIPlan(current.input, env, { ...options, materialsContext });
    const run = await saveRun(env, owner, recordId, { revision: current.revision, inputSnapshot: current.input, attachmentIds: ids, plan, materialSummary: materialsContext.summary });
    const record = await getRecord(env, owner, recordId);
    return json({ record, run, plan, stale: record.revision !== current.revision });
  } finally { activeAnalyses.delete(lock); }
}

/** All routes require a trusted platform user; callers cannot choose an owner. */
export async function handleWorkspaceAPI(request, env, options = {}) {
  const owner = options.localOwnerId || request.headers.get('oai-authenticated-user-id');
  if (!owner) return json({ error: '请登录后使用案件历史与资料归档。' }, 401);
  try {
    requireStorage(env);
    const url = new URL(request.url);
    const path = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    if (path[0] !== 'api' || path[1] !== 'records' || path.length > 6) throw new RecordError(404, '接口不存在。');
    const method = request.method;
    if (path.length === 2) {
      if (method === 'GET') return json({ records: await listRecords(env, owner, { query: url.searchParams.get('q') || '', status: url.searchParams.get('status') || 'all' }) });
      if (method === 'POST') return json({ record: await createRecord(env, owner, await readJSON(request)) }, 201);
      return json({ error: '请求方法不支持。' }, 405, { Allow: 'GET, POST' });
    }
    const recordId = path[2];
    if (path.length === 3) {
      if (method === 'GET') return json({ record: await getRecord(env, owner, recordId) });
      if (method === 'PATCH') return json({ record: await updateRecord(env, owner, recordId, await readJSON(request)) });
      return json({ error: '请求方法不支持。' }, 405, { Allow: 'GET, PATCH' });
    }
    if (path[3] === 'attachments') {
      if (path.length === 4 && method === 'POST') return await upload(request, env, owner, recordId);
      if (path.length === 5 && method === 'DELETE') return json({ record: await removeAttachment(env, owner, recordId, path[4]) });
      if (path.length === 6 && path[5] === 'content' && method === 'GET') return await download(request, env, owner, recordId, path[4]);
    }
    if (path.length === 4 && path[3] === 'analyze' && method === 'POST') return await analyze(request, env, owner, recordId, options);
    if (path.length === 4 && path[3] === 'notes' && method === 'POST') {
      const note = await addNote(env, owner, recordId, await readJSON(request));
      return json({ note, record: await getRecord(env, owner, recordId) }, 201);
    }
    throw new RecordError(404, '接口不存在或方法不支持。');
  } catch (error) {
    if (error instanceof RecordError || error instanceof MaterialError) return json({ error: error.message }, error.status || 400);
    if (error instanceof InputError) return json({ error: error.message }, 400);
    return json({ error: '案件操作暂未完成，请稍后重试。' }, 500);
  }
}

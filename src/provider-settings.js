import { probeDeepSeek, probeResult } from './provider-probe.js';

const DEFAULT_MODEL = 'deepseek-flash';
const MODEL = /^deepseek-[a-z0-9.-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ENCODER = new TextEncoder();
const BODY_LIMIT = 8 * 1024;
const CACHE_MS = 60 * 1000;
const STALE_MS = 5 * 60 * 1000;
const PROBE_INTERVAL = 10 * 1000;
const probeStarts = new Map();
const activeOwners = new Set();
let activeProbes = 0;
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export class ProviderError extends Error {
  constructor(status, message) { super(message); this.name = 'ProviderError'; this.status = status; }
}
function json(value, status = 200, extra = {}) { return new Response(JSON.stringify(value), { status, headers: { ...HEADERS, ...extra } }); }
function ownerFor(request, options) {
  const owner = options.localOwnerId || request?.headers.get('oai-authenticated-user-id');
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 256 || CONTROL.test(owner)) throw new ProviderError(401, '请登录后管理 AI 服务。');
  return owner;
}
function database(env) {
  if (!env?.DB?.prepare) throw new ProviderError(503, 'AI 配置存储暂不可用。');
  return env.DB;
}
function nowValue(options) { return typeof options.now === 'function' ? options.now() : Date.now(); }
function runtime(env) {
  return { key: typeof env.DEEPSEEK_API_KEY === 'string' ? env.DEEPSEEK_API_KEY.trim() : '', model: MODEL.test(env.DEEPSEEK_MODEL) ? env.DEEPSEEK_MODEL : DEFAULT_MODEL };
}
function fromBase64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function toBase64(bytes) { return btoa(String.fromCharCode(...bytes)); }
async function encryptionKey(env) {
  try {
    const bytes = fromBase64(env.AI_CONFIG_ENCRYPTION_KEY);
    if (bytes.byteLength !== 32) return null;
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch { return null; }
}
function aad(owner) { return ENCODER.encode(JSON.stringify({ owner, provider: 'deepseek', version: 1 })); }
async function encrypt(key, owner, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(owner) }, key, ENCODER.encode(plaintext));
  return { ciphertext: toBase64(new Uint8Array(encrypted)), iv: toBase64(iv) };
}
async function decrypt(key, owner, row) {
  try {
    const iv = fromBase64(row.iv);
    if (iv.byteLength !== 12) throw new Error('Invalid IV');
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(owner) }, key, fromBase64(row.ciphertext));
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!value || value.length > 512 || !/^[!-~]+$/.test(value)) throw new Error('Invalid key');
    return value;
  } catch { throw new ProviderError(503, '已保存的 AI 密钥暂不可读取，请重新保存密钥或恢复默认配置。'); }
}
async function rowFor(db, owner) { return db.prepare('SELECT * FROM recovery_provider_settings WHERE owner_id = ?').bind(owner).first(); }
function revisionOf(row) { return row?.revision ?? 0; }
function hasSavedKey(row) { return row?.ciphertext != null && row?.iv != null; }
async function stateFor(env, owner, row) {
  const defaults = runtime(env);
  const master = await encryptionKey(env);
  const base = { mode: row?.mode || 'default', model: row?.model || defaults.model, key: '', source: 'none', master };
  if (base.mode === 'disabled') return { ...base, source: 'disabled' };
  if (base.mode === 'custom') {
    if (!master) return { ...base, source: 'saved', configurationError: 'encryption_unavailable' };
    try { return { ...base, source: 'saved', key: await decrypt(master, owner, row) }; }
    catch { return { ...base, source: 'saved', configurationError: 'saved_key_unreadable' }; }
  }
  return { ...base, key: defaults.key, source: defaults.key ? 'environment' : 'none' };
}
async function fingerprint(owner, state) {
  const bytes = await crypto.subtle.digest('SHA-256', ENCODER.encode(JSON.stringify({ owner, provider: 'deepseek', mode: state.mode, key: state.key, model: state.model, configurationError: state.configurationError || '' })));
  return toBase64(new Uint8Array(bytes));
}
function safeCheck(serialized) {
  try {
    const value = JSON.parse(serialized);
    if (!value || typeof value.status !== 'string' || typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt)) || !Number.isFinite(value.latencyMs) || value.latencyMs < 0) return null;
    const check = probeResult(value.status, { checkedAt: value.checkedAt, latencyMs: value.latencyMs });
    for (const field of ['modelAvailable', 'supportsImages']) if (typeof value[field] === 'boolean') check[field] = value[field];
    return check;
  } catch { return null; }
}
async function statusFor(env, owner, row, options, state) {
  state ||= await stateFor(env, owner, row);
  const matches = row?.probe_fingerprint && row.probe_fingerprint === await fingerprint(owner, state);
  const lastCheck = matches && !state.configurationError ? safeCheck(row.probe_json) : null;
  return {
    provider: 'DeepSeek', endpoint: 'https://api.deepseek.com', configured: Boolean(state.key), model: state.model,
    source: state.source, revision: revisionOf(row), hasSavedKey: hasSavedKey(row), manualConfigAvailable: Boolean(state.master), updatedAt: row?.updated_at || null,
    lastCheck, stale: !lastCheck || nowValue(options) - Date.parse(lastCheck.checkedAt) > STALE_MS,
    ...(state.configurationError ? { configurationError: state.configurationError } : {}),
  };
}

/** Safe metadata only: this function never makes an external request. */
export async function getProviderStatus(request, env = {}, options = {}) {
  const owner = ownerFor(request, options);
  const row = await rowFor(database(env), owner);
  return statusFor(env, owner, row, options);
}

/** Resolve an owner's active credentials without changing the shared environment. */
export async function resolveProviderEnvironment(request, env = {}, options = {}) {
  if (!env.DB?.prepare || !(options.localOwnerId || request?.headers.get('oai-authenticated-user-id'))) return env;
  const owner = ownerFor(request, options);
  const row = await rowFor(database(env), owner);
  const state = await stateFor(env, owner, row);
  if (state.configurationError) throw new ProviderError(503, '已保存的 AI 密钥暂不可读取，请重新保存密钥或恢复默认配置。');
  return { ...env, DEEPSEEK_API_KEY: state.key, DEEPSEEK_MODEL: state.model };
}

async function readJSON(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ProviderError(400, '请使用 JSON 格式提交。');
  const length = request.headers.get('Content-Length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > BODY_LIMIT) throw new ProviderError(413, 'AI 配置提交内容超过8KiB。');
  if (!request.body) throw new ProviderError(400, '提交内容为空。');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) { await reader.cancel(); throw new ProviderError(413, 'AI 配置提交内容超过8KiB。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ProviderError(400, 'AI 配置提交格式无效。'); }
}
function shape(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new ProviderError(400, 'AI 配置包含无效字段。');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new ProviderError(400, '请提供有效的 AI 配置版本号。');
  return value;
}
function conflict() { return new ProviderError(409, 'AI 配置已更新，请刷新配置后再提交。'); }
function changes(result) { return Number(result?.meta?.changes || 0); }

async function save(request, env, owner, db, options) {
  const body = shape(await readJSON(request), ['revision', 'action', 'model', 'apiKey']);
  if (!['save', 'default', 'disable'].includes(body.action)) throw new ProviderError(400, 'AI 配置操作无效。');
  if (body.action !== 'save' && (body.model !== undefined || body.apiKey !== undefined)) throw new ProviderError(400, '此操作不接受模型或密钥。');
  const row = await rowFor(db, owner);
  if (revisionOf(row) !== body.revision) throw conflict();
  const updatedAt = new Date(nowValue(options)).toISOString();
  let mode = body.action === 'disable' ? 'disabled' : 'default';
  let model = '';
  let ciphertext = null;
  let iv = null;
  if (body.action === 'disable') {
    model = row?.model || '';
    ciphertext = row?.ciphertext ?? null;
    iv = row?.iv ?? null;
  }
  if (body.action === 'save') {
    if (body.model !== undefined && (typeof body.model !== 'string' || !MODEL.test(body.model))) throw new ProviderError(400, '模型名称须为有效的 deepseek- 模型标识。');
    model = body.model ?? (row?.model || runtime(env).model);
    if (body.apiKey !== undefined && typeof body.apiKey !== 'string') throw new ProviderError(400, 'API Key 格式无效。');
    const supplied = (body.apiKey || '').trim();
    if (supplied && (supplied.length > 512 || !/^[!-~]+$/.test(supplied))) throw new ProviderError(400, 'API Key 格式无效。');
    if (supplied) {
      const master = await encryptionKey(env);
      if (!master) throw new ProviderError(503, 'AI 密钥加密服务尚未就绪，暂不能保存新密钥。');
      ({ ciphertext, iv } = await encrypt(master, owner, supplied));
      mode = 'custom';
    } else if (hasSavedKey(row)) {
      const state = await stateFor(env, owner, { ...row, mode: 'custom' });
      if (state.configurationError) throw new ProviderError(503, '已保存的 AI 密钥暂不可读取，请重新输入密钥或恢复默认配置。');
      mode = 'custom'; ciphertext = row.ciphertext; iv = row.iv;
    } else if (!runtime(env).key) throw new ProviderError(400, '请先输入 API Key；当前没有可沿用的密钥。');
  }
  const revision = body.revision + 1;
  const statement = row
    ? db.prepare('UPDATE recovery_provider_settings SET revision = ?, mode = ?, ciphertext = ?, iv = ?, model = ?, updated_at = ?, probe_json = NULL, probe_fingerprint = NULL WHERE owner_id = ? AND revision = ?').bind(revision, mode, ciphertext, iv, model, updatedAt, owner, body.revision)
    : db.prepare('INSERT INTO recovery_provider_settings (owner_id, revision, mode, ciphertext, iv, model, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET revision = excluded.revision, mode = excluded.mode, ciphertext = excluded.ciphertext, iv = excluded.iv, model = excluded.model, updated_at = excluded.updated_at, probe_json = NULL, probe_fingerprint = NULL WHERE recovery_provider_settings.revision = ?').bind(owner, revision, mode, ciphertext, iv, model, updatedAt, body.revision);
  if (changes(await statement.run()) !== 1) throw conflict();
  return json(await statusFor(env, owner, await rowFor(db, owner), options));
}

async function storeCheck(db, owner, initialRow, state, check, token, options) {
  if (!initialRow) return changes(await db.prepare('INSERT INTO recovery_provider_settings (owner_id, revision, mode, model, updated_at, probe_json, probe_fingerprint) VALUES (?, 0, ?, ?, ?, ?, ?) ON CONFLICT(owner_id) DO NOTHING')
    .bind(owner, state.mode, '', new Date(nowValue(options)).toISOString(), JSON.stringify(check), token).run()) === 1;
  return changes(await db.prepare('UPDATE recovery_provider_settings SET probe_json = ?, probe_fingerprint = ? WHERE owner_id = ? AND revision = ?')
    .bind(JSON.stringify(check), token, owner, initialRow.revision).run()) === 1;
}

async function test(request, env, owner, db, options) {
  const body = shape(await readJSON(request), ['revision', 'force']);
  if (body.force !== undefined && typeof body.force !== 'boolean') throw new ProviderError(400, '检测选项无效。');
  const initialRow = await rowFor(db, owner);
  if (revisionOf(initialRow) !== body.revision) throw conflict();
  const state = await stateFor(env, owner, initialRow);
  if (state.configurationError) throw new ProviderError(503, '已保存的 AI 密钥暂不可读取，请重新保存密钥或恢复默认配置。');
  const token = await fingerprint(owner, state);
  const current = await statusFor(env, owner, initialRow, options, state);
  const now = nowValue(options);
  if (!body.force && current.lastCheck && now - Date.parse(current.lastCheck.checkedAt) < CACHE_MS) return json({ ...current, cached: true });
  let check;
  if (state.mode === 'disabled') check = probeResult('disabled', { checkedAt: new Date(now).toISOString() });
  else if (!state.key) check = probeResult('not_configured', { checkedAt: new Date(now).toISOString() });
  else {
    const lastStart = probeStarts.get(owner);
    if (activeOwners.has(owner) || (lastStart !== undefined && now - lastStart < PROBE_INTERVAL)) throw new ProviderError(429, '连接检测过于频繁，请10秒后手动重试。');
    if (activeProbes >= 2) throw new ProviderError(429, '已有连接检测正在进行，请稍后手动重试。');
    activeOwners.add(owner); activeProbes += 1; probeStarts.set(owner, now);
    // Bound the per-isolate cooldown map without affecting active owners.
    if (probeStarts.size > 1000) for (const [id, at] of probeStarts) if (now - at > PROBE_INTERVAL && !activeOwners.has(id)) probeStarts.delete(id);
    try { check = await probeDeepSeek({ key: state.key, model: state.model, fetchImpl: options.fetchImpl, now: options.now || Date.now, timeoutMs: options.probeTimeoutMs ?? 8000 }); }
    finally { activeOwners.delete(owner); activeProbes -= 1; }
  }
  // Resolve again after I/O: an old result must not label newer credentials online.
  const latestRow = await rowFor(db, owner);
  const latestState = await stateFor(env, owner, latestRow);
  const unchanged = revisionOf(latestRow) === body.revision && await fingerprint(owner, latestState) === token;
  const stored = unchanged && await storeCheck(db, owner, initialRow, state, check, token, options);
  const result = await statusFor(env, owner, await rowFor(db, owner), options);
  return json(stored ? result : { ...result, discarded: true, message: '配置已变化，本次检测结果未应用，请检测当前配置。' });
}

export async function handleProviderAPI(request, env = {}, options = {}) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if ((origin !== null && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') return json({ error: '请从本站页面提交请求。' }, 403);
  try {
    const owner = ownerFor(request, options);
    const db = database(env);
    if (url.pathname === '/api/provider') {
      if (request.method === 'GET') return json(await getProviderStatus(request, env, options));
      if (request.method === 'PATCH') return await save(request, env, owner, db, options);
      return json({ error: '请求方法不支持。' }, 405, { Allow: 'GET, PATCH' });
    }
    if (url.pathname === '/api/provider/test') {
      if (request.method !== 'POST') return json({ error: '请求方法不支持。' }, 405, { Allow: 'POST' });
      return await test(request, env, owner, db, options);
    }
    return json({ error: '接口不存在。' }, 404);
  } catch (error) {
    if (error instanceof ProviderError) return json({ error: error.message }, error.status);
    return json({ error: 'AI 服务配置操作暂未完成，请稍后重试。' }, 500);
  }
}

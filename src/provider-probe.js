/** A bounded, credential-only connectivity check against DeepSeek's fixed API. */
const MODELS_ENDPOINT = 'https://api.deepseek.com/models';
const BODY_LIMIT = 64 * 1024;
const DETAILS = Object.freeze({
  online: ['连接正常', '已连接 DeepSeek，身份验证和所选模型通过检查。本次未生成内容，不能确认余额或保证实际生成成功。'],
  not_configured: ['尚未配置', '请先保存可用的 API Key，再检测连接。'],
  disabled: ['已停用', '当前账户已停用 AI 服务。'],
  auth_error: ['密钥验证失败', 'DeepSeek 未接受当前密钥，请检查并重新保存。'],
  insufficient_balance: ['余额不足', 'DeepSeek 返回余额不足，请在服务商账户中核对。'],
  rate_limited: ['请求受限', 'DeepSeek 当前限制请求频率，请稍后手动重试。'],
  unavailable: ['服务暂不可用', 'DeepSeek 暂未完成连接检查，请稍后手动重试。'],
  timeout: ['检测超时', '连接检查超过时间限制，请稍后手动重试。'],
  network_error: ['网络连接失败', '暂时无法连接 DeepSeek，请稍后手动重试。'],
  model_unavailable: ['模型不可用', '身份验证已通过，但模型列表中未找到所选模型，请核对模型名称。'],
  invalid_response: ['响应无法验证', 'DeepSeek 返回的连接检查结果无法验证，请稍后手动重试。'],
});

export function probeResult(status, { checkedAt = new Date().toISOString(), latencyMs = 0, ...metadata } = {}) {
  const [label, detail] = DETAILS[status] || DETAILS.invalid_response;
  return { status: DETAILS[status] ? status : 'invalid_response', label, detail, checkedAt, latencyMs, ...metadata };
}

function discard(response) {
  try { response.body?.cancel().catch(() => {}); } catch {}
}

/** Includes fetching and reading the bounded response body in the deadline. */
export async function probeDeepSeek({ key, model, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000 }) {
  const started = now();
  const controller = new AbortController();
  let timer;
  let reader;
  let timedOut = false;
  const metadata = () => ({ checkedAt: new Date(now()).toISOString(), latencyMs: Math.max(0, Math.round(now() - started)) });
  const work = async () => {
    const response = await fetchImpl(MODELS_ENDPOINT, {
      method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}` }, signal: controller.signal,
    });
    if (timedOut) { discard(response); return probeResult('timeout', metadata()); }
    if (response.status !== 200) {
      discard(response);
      const status = ({ 401: 'auth_error', 402: 'insufficient_balance', 429: 'rate_limited', 500: 'unavailable', 503: 'unavailable' })[response.status]
        || (response.status >= 500 ? 'unavailable' : 'invalid_response');
      return probeResult(status, metadata());
    }
    const length = response.headers.get('Content-Length');
    if (length !== null && /^\d+$/.test(length) && Number(length) > BODY_LIMIT) { discard(response); return probeResult('invalid_response', metadata()); }
    if (!response.body) return probeResult('invalid_response', metadata());
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > BODY_LIMIT) { reader.cancel().catch(() => {}); return probeResult('invalid_response', metadata()); }
        chunks.push(value);
      }
    } finally { try { reader.releaseLock(); } catch {} reader = null; }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { return probeResult('invalid_response', metadata()); }
    if (!data || typeof data !== 'object' || !Array.isArray(data.data) || data.data.some((item) => !item || typeof item !== 'object' || typeof item.id !== 'string')) return probeResult('invalid_response', metadata());
    const selected = data.data.find((item) => item.id === model);
    if (!selected) return probeResult('model_unavailable', { ...metadata(), modelAvailable: false });
    const modalities = selected.input_modalities;
    const capability = Array.isArray(modalities) && modalities.every((item) => typeof item === 'string')
      ? { supportsImages: modalities.includes('image') } : {};
    return probeResult('online', { ...metadata(), modelAvailable: true, ...capability });
  };
  try {
    return await Promise.race([
      work(),
      new Promise((resolve) => { timer = setTimeout(() => {
        timedOut = true; controller.abort();
        try { reader?.cancel().catch(() => {}); } catch {}
        resolve(probeResult('timeout', metadata()));
      }, timeoutMs); }),
    ]);
  } catch {
    return probeResult(timedOut ? 'timeout' : 'network_error', metadata());
  } finally { clearTimeout(timer); }
}

import { generateAIPlan, getAIConfiguration, InputError } from './ai.js';

const BODY_LIMIT = 32 * 1024;
const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), { status, headers: { ...HEADERS, ...extra } });
}

class BodyLimitError extends Error {}

async function readJSON(request) {
  const length = request.headers.get('Content-Length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > BODY_LIMIT) throw new BodyLimitError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) { await reader.cancel(); throw new BodyLimitError(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Shared Fetch API handler for the local Node server and the private Worker. */
export async function handleAPI(request, env = {}, options = {}) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  // Same-origin JSON requests rely on the owner's private platform boundary.
  // No CORS headers or preflight exemptions are provided.
  if ((origin !== null && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    return json({ error: '请从本站页面提交请求。' }, 403);
  }
  const route = url.pathname;
  if (route !== '/api/health' && route !== '/api/plan') return json({ error: '接口不存在。' }, 404);
  const method = route === '/api/health' ? 'GET' : 'POST';
  if (request.method !== method) return json({ error: '请求方法不支持。' }, 405, { Allow: method });
  if (route === '/api/health') {
    const { configured, model } = getAIConfiguration(env);
    return json({ provider: 'DeepSeek', configured, model });
  }
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: '请使用 JSON 格式提交项目情况。' }, 400);
  }
  let input;
  try { input = await readJSON(request); }
  catch (error) {
    return error instanceof BodyLimitError
      ? json({ error: '提交内容过大，请控制在32KB以内。' }, 413)
      : json({ error: '项目数据格式无效，请重新提交。' }, 400);
  }
  try { return json({ plan: await generateAIPlan(input, env, options) }); }
  catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, 400);
    return json({ error: '暂时无法生成方案，请稍后再试。' }, 500);
  }
}

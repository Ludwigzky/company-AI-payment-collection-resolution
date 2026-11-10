// Reads hidden terminal input. No credential is saved or printed.
const raw = await new Promise((resolve, reject) => {
  let value = '';
  const terminal = process.stdin.isTTY;
  const finish = (error) => {
    process.stdin.removeListener('data', onData);
    process.stdin.removeListener('end', onEnd);
    if (terminal) process.stdin.setRawMode(false);
    process.stdin.pause();
    error ? reject(error) : resolve(value);
  };
  const onData = (chunk) => {
    value += chunk;
    if (value.includes('\u0003')) finish(new Error('Cancelled'));
    else if (value.length > 4096) finish(new Error('Invalid input'));
    else if (value.includes('\n') || value.includes('\r')) finish();
  };
  const onEnd = () => finish();
  if (terminal) { process.stdin.setRawMode(true); process.stderr.write('Ready for check JSON on stdin (input is hidden).\n'); }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  process.stdin.once('end', onEnd);
  process.stdin.resume();
});
const { key, mode = 'models' } = JSON.parse(raw);
if (!key || typeof key !== 'string') throw new Error('Missing stdin credential');
try {
  if (mode === 'models') {
    const response = await fetch('https://api.deepseek.com/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
    const payload = response.ok ? await response.json() : null;
    console.log(JSON.stringify({ check: 'models', status: response.status, ok: response.ok, configuredModelAvailable: !!payload?.data?.some((model) => model.id === 'deepseek-flash') }));
    if (!response.ok) process.exitCode = 1;
  } else if (mode === 'plan') {
    const { generateAIPlan } = await import('../src/ai.js');
    const diagnostics = {};
    const inspectedFetch = async (...args) => {
      const response = await fetch(...args);
      diagnostics.status = response.status;
      if (response.ok) {
        try {
          const envelope = await response.clone().json();
          const choice = envelope.choices?.[0];
          diagnostics.finishReason = choice?.finish_reason;
          diagnostics.contentLength = choice?.message?.content?.length || 0;
          try {
            const value = JSON.parse(choice?.message?.content);
            diagnostics.fieldNames = Object.keys(value);
            diagnostics.lengths = Object.fromEntries(Object.entries(value).map(([field, item]) => [field, typeof item === 'string' ? item.length : Array.isArray(item) ? item.length : typeof item]));
            diagnostics.sourceIds = value.recommendations?.map((item) => ({ track: item.track, sourceIds: item.sourceIds }));
            const patterns = [/https?:|www\./i, /第[零一二三四五六七八九十百千万〇两\d]+(?:条|款|项)/, /锁机|恐吓|威胁|骚扰|曝光|公开个人信息|扣押|取回设备/, /(?:保证|确保|承诺|百分之百|100\s*%)[^。；;\n]{0,12}(?:回款|胜诉|受理|追回)/];
            diagnostics.suspectFields = [];
            const visit = (item, field) => {
              if (typeof item === 'string') patterns.forEach((pattern, index) => { if (pattern.test(item)) diagnostics.suspectFields.push({ field, rule: index }); });
              else if (item && typeof item === 'object') Object.entries(item).forEach(([name, child]) => visit(child, field + '.' + name));
            };
            visit(value, 'ai');
          } catch { diagnostics.jsonParsed = false; }
        } catch { diagnostics.envelopeParsed = false; }
      }
      return response;
    };
    const plan = await generateAIPlan({ amount: 328000, dueDate: '2026-08-12', issueText: '虚构演示：设备已交付，对方反馈运行不稳定，尚未确认故障原因，验收存在争议，客户希望维修后支付尾款。', projectType: 'equipment', issueTypes: ['repair', 'acceptance'], debtorType: 'enterprise', creditorSize: 'unknown', acceptanceStatus: 'disputed', evidence: ['contract', 'delivery', 'invoice'], disputeClause: 'unknown', disputeAccepted: 'unknown' }, { DEEPSEEK_API_KEY: key, DEEPSEEK_MODEL: 'deepseek-flash' }, { today: '2026-11-10', fetchImpl: inspectedFetch });
    console.log(JSON.stringify({ check: 'plan', mode: plan.generation?.mode, model: plan.generation?.model, analysisLength: plan.ai?.analysis?.length || 0, recommendationCount: plan.ai?.recommendations?.length || 0, reason: plan.generation?.reason || null }));
    console.log(JSON.stringify({ diagnostics }).replaceAll(key, '[REDACTED]').replace(/sk-[a-z0-9_-]{10,}/gi, '[REDACTED]'));
    if (plan.generation?.mode !== 'ai') process.exitCode = 1;
  } else throw new Error('Unknown check mode');
} catch (error) {
  console.log(JSON.stringify({ check: mode, ok: false, errorType: error.name, message: 'Connectivity or generation check did not complete.' }));
  process.exitCode = 1;
}

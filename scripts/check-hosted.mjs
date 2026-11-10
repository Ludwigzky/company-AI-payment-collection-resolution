// Uses a temporary Sites service credential supplied through hidden stdin.
// The credential is sent only to this verified private Site, never to DeepSeek.
const input = await new Promise((resolve, reject) => {
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
    else if (value.length > 16384) finish(new Error('Invalid input'));
    else if (value.includes('\n') || value.includes('\r')) finish();
  };
  const onEnd = () => finish();
  if (terminal) { process.stdin.setRawMode(true); process.stderr.write('Ready for hosted check JSON on stdin (input is hidden).\n'); }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  process.stdin.once('end', onEnd);
  process.stdin.resume();
});
const { token, liveAI = false } = JSON.parse(input);
const origin = 'https://huikuan-recovery-demo.perkychick69.chatgpt.site';
if (!token || typeof token !== 'string') throw new Error('Missing service credential');
const headers = { 'OAI-Sites-Authorization': 'Bearer ' + token };
try {
  for (const pathname of ['/', '/app.js', '/api/health']) {
    const response = await fetch(origin + pathname, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
    const result = { check: 'hosted', pathname, status: response.status };
    if (pathname === '/api/health' && response.ok) {
      const status = await response.json();
      result.configured = status.configured;
      result.model = status.model;
    }
    console.log(JSON.stringify(result));
    if (!response.ok) throw new Error('Deployment check failed');
  }
  if (liveAI) {
    const response = await fetch(origin + '/api/plan', {
      method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 328000, dueDate: '2026-08-12', issueText: '虚构设备案例：设备已交付，客户反馈运行不稳定，以维修和待验收为由暂缓支付尾款。故障原因和责任尚未核实，拟协调维修并对账。', projectType: 'equipment', issueTypes: ['repair', 'acceptance'], evidence: ['contract', 'delivery', 'invoice'], acceptanceStatus: 'disputed', debtorType: 'enterprise', creditorSize: 'unknown', disputeClause: 'unknown', disputeAccepted: 'unknown' }),
      signal: AbortSignal.timeout(65000), redirect: 'error',
    });
    if (!response.ok) { console.log(JSON.stringify({ check: 'hosted-ai', status: response.status })); throw new Error('Deployment generation failed'); }
    const { plan } = await response.json();
    console.log(JSON.stringify({ check: 'hosted-ai', status: response.status, mode: plan?.generation?.mode, model: plan?.generation?.model, analysisLength: plan?.ai?.analysis?.length || 0, recommendationCount: plan?.ai?.recommendations?.length || 0, reason: plan?.generation?.reason || null }));
    if (plan?.generation?.mode !== 'ai') process.exitCode = 1;
  }
} catch {
  console.log(JSON.stringify({ check: 'hosted', ok: false, message: 'Hosted verification did not complete.' }));
  process.exitCode = 1;
}

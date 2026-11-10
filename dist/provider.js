const DEFAULT_MODEL = 'deepseek-flash';
const CHECK_TTL = 5 * 60 * 1000;
const MODEL_PATTERN = /^deepseek-[a-z0-9.-]{1,64}$/;
const SOURCES = { saved: '当前账号手动配置', environment: '本环境默认密钥', none: '未配置', disabled: '当前账号已停用' };
const CHECK_LABELS = {
  online: '连接正常', not_configured: '未配置', disabled: '已停用', auth_error: '鉴权失败',
  timeout: '连接超时', model_unavailable: '模型不可用', insufficient_balance: '余额不足',
  rate_limited: '请求受限', unavailable: '服务不可用', network_error: '连接异常', invalid_response: '响应异常',
};

function publicState(value) {
  if (!value || !Object.hasOwn(SOURCES, value.source) || !['string', 'number'].includes(typeof value.revision)) throw new Error('Invalid provider state');
  const check = value.lastCheck && typeof value.lastCheck === 'object' ? value.lastCheck : null;
  return {
    configured: value.configured === true, hasSavedKey: value.hasSavedKey === true, source: value.source, revision: value.revision,
    model: typeof value.model === 'string' && MODEL_PATTERN.test(value.model) ? value.model : DEFAULT_MODEL,
    manualConfigAvailable: value.manualConfigAvailable === true, stale: value.stale === true,
    configurationError: ['encryption_unavailable', 'saved_key_unreadable'].includes(value.configurationError) ? value.configurationError : null,
    lastCheck: check ? {
      status: Object.hasOwn(CHECK_LABELS, check.status) ? check.status : 'invalid_response',
      detail: typeof check.detail === 'string' ? check.detail.slice(0, 1200) : '',
      checkedAt: typeof check.checkedAt === 'string' ? check.checkedAt : null,
      latencyMs: Number.isFinite(check.latencyMs) && check.latencyMs >= 0 ? check.latencyMs : null,
      modelAvailable: typeof check.modelAvailable === 'boolean' ? check.modelAvailable : null,
      supportsImages: typeof check.supportsImages === 'boolean' ? check.supportsImages : null,
    } : null,
  };
}

export function initProvider({ api }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('provider-dialog');
  if (!dialog || typeof api !== 'function') return;
  const keyInput = $('provider-key');
  const modelInput = $('provider-model');
  let current = null;
  let baseline = null;
  let unavailable = true;
  let busy = '';
  let reading = false;
  let epoch = 0;
  let conflict = false;
  let conflictReviewed = false;
  let destroyed = false;
  let expiryTimer = null;
  const autoAttempts = new Set();

  const dirty = () => Boolean(dialog.open && baseline && (keyInput.value.length || modelInput.value !== baseline.model));
  const expired = () => Boolean(current?.lastCheck && (current.stale || !Number.isFinite(Date.parse(current.lastCheck.checkedAt)) || Date.now() - Date.parse(current.lastCheck.checkedAt) >= CHECK_TTL));
  const checkToken = () => JSON.stringify([current?.revision, current?.lastCheck?.checkedAt || null]);
  function message(text, kind = '') {
    $('provider-message').textContent = text;
    $('provider-message').className = `notice${kind ? ` ${kind}` : ''}`;
    $('provider-message').hidden = !text;
  }
  function status() {
    if (unavailable || !current) return { label: '平台状态未知', tone: 'unknown' };
    if (current.source === 'disabled') return { label: '已停用', tone: 'neutral' };
    if (current.configurationError) return { label: '配置不可用', tone: 'warning' };
    if (!current.configured) return { label: '未配置', tone: 'neutral' };
    if (!current.lastCheck) return { label: '已配置待检测', tone: 'neutral' };
    if (expired()) return { label: '检测已过期', tone: 'warning' };
    return { label: CHECK_LABELS[current.lastCheck.status] || '状态未知', tone: current.lastCheck.status === 'online' ? 'online' : 'warning' };
  }
  function hydrate() {
    if (!current || !dialog.open) return;
    baseline = { revision: current.revision, model: current.model };
    modelInput.value = current.model;
    keyInput.value = '';
    conflict = false;
    conflictReviewed = false;
  }
  function accept(value, { resetEditor = false, reviewConflict = false } = {}) {
    const next = publicState(value);
    const changedSinceDraft = baseline && next.revision !== baseline.revision;
    const changedSinceRead = current && next.revision !== current.revision;
    const hadDraft = dirty();
    current = next;
    unavailable = false;
    window.clearTimeout(expiryTimer);
    const untilExpiry = Date.parse(current.lastCheck?.checkedAt) + CHECK_TTL - Date.now();
    if (!current.stale && Number.isFinite(untilExpiry) && untilExpiry > 0) {
      expiryTimer = window.setTimeout(() => { if (!destroyed) { render(); maybeAutoTest(); } }, Math.min(untilExpiry + 10, 2147483647));
    }
    if (dialog.open && (resetEditor || !baseline || (!hadDraft && !conflict))) hydrate();
    else if (dialog.open && changedSinceDraft) {
      if (!conflict || changedSinceRead) conflictReviewed = false;
      conflict = true;
      if (reviewConflict) conflictReviewed = true;
      message('配置已在其他页面更新。填写内容仍保留；请刷新配置状态并采用最新版本后，再保存。', 'warning');
    }
    render();
  }
  function render() {
    const state = status();
    $('provider-status').textContent = `DeepSeek · ${state.label}`;
    $('provider-open').dataset.state = state.tone;
    $('provider-open').title = unavailable ? '平台配置状态读取失败，点击查看或重试' : `DeepSeek · ${state.label}，打开 API 配置`;
    $('provider-current-status').textContent = `当前已保存配置 · ${state.label}`;
    $('provider-source').textContent = current ? SOURCES[current.source] : '状态未读取';
    $('provider-current-model').textContent = current?.model || '—';
    const check = current?.lastCheck;
    const checkedAt = check?.checkedAt && Date.parse(check.checkedAt);
    $('provider-checked').textContent = checkedAt && Number.isFinite(checkedAt) ? `${new Date(checkedAt).toLocaleString('zh-CN', { hour12: false })}${expired() ? '（已过期）' : ''}` : '尚未检测';
    $('provider-latency').textContent = check?.latencyMs !== null && check?.latencyMs !== undefined ? `${Math.round(check.latencyMs)} ms` : '—';
    let detail = current?.configured ? (check?.detail || '已保存配置，尚未完成连接检测。') : '请填写 API Key 并保存，或恢复本环境默认配置。';
    if (current?.source === 'disabled') detail = current.hasSavedKey ? '当前账号已暂停 DeepSeek，已保存的密钥与模型仍保留。留空保存可重新启用；恢复默认会移除手动配置。' : '当前账号已停用 DeepSeek。恢复默认或重新保存配置后可启用。';
    if (current?.configurationError === 'saved_key_unreadable') detail = '已保存的密钥无法读取。请重新输入密钥保存，或恢复默认配置。';
    if (current?.configurationError === 'encryption_unavailable') detail = '本环境暂时无法解密或保存手动密钥，请联系管理员检查加密设置，或恢复默认配置。';
    if (unavailable) detail = '平台暂时无法读取配置状态，不能据此判断 DeepSeek 是否在线。请刷新配置状态重试。';
    $('provider-detail').textContent = detail;
    $('provider-image-support').textContent = check?.supportsImages === true ? '检测到模型声明支持图像；具体材料仍需以生成结果核对。' : check?.supportsImages === false ? '当前模型未声明图像支持，请使用文字材料或选择支持图像的模型。' : '图像支持未确认，请先使用文字材料。';
    keyInput.placeholder = current?.configured || current?.hasSavedKey ? '已配置（密钥不回显），留空保留' : '输入 API Key';
    const editable = Boolean(current?.manualConfigAvailable && !unavailable);
    modelInput.disabled = !editable || Boolean(busy);
    keyInput.disabled = !editable || Boolean(busy);
    $('provider-save').disabled = !editable || !baseline || Boolean(busy) || conflict;
    $('provider-default').disabled = !current || unavailable || Boolean(busy) || conflict;
    $('provider-disable').disabled = !current || unavailable || Boolean(busy) || conflict || current.source === 'disabled';
    $('provider-test').disabled = !current?.configured || current.source === 'disabled' || unavailable || Boolean(busy) || dirty() || conflict;
    $('provider-test').textContent = busy === 'test' ? '正在检测…' : '检测已保存配置';
    $('provider-save').textContent = busy === 'save' ? '正在保存…' : '保存配置';
    $('provider-refresh').disabled = reading || Boolean(busy);
    $('provider-refresh').textContent = reading ? '正在读取…' : '刷新配置状态';
    $('provider-rebase').hidden = !conflict;
    $('provider-rebase').disabled = !conflictReviewed || unavailable || Boolean(busy) || reading;
    let hint = '检测使用当前已保存配置。';
    if (dirty()) hint = '有未保存的修改，请先保存，再检测已保存配置。';
    if (!editable && current && !unavailable) hint = '当前环境暂不支持手动保存密钥；可恢复默认配置或联系管理员。';
    if (conflict) hint = conflictReviewed ? '已读取最新配置。可采用最新版本并保留填写内容，再次保存。' : '请先刷新配置状态；填写内容和原版本仍保留。';
    $('provider-draft-hint').textContent = hint;
  }
  function safeFailure(error, action) {
    if (error?.status === 409) return '配置已在其他页面更新。填写内容仍保留，请刷新配置状态后再继续。';
    if (error?.status === 401 || error?.status === 403) return '当前账号无权操作此配置，请刷新页面并重新登录。';
    if (error?.status === 400 || error?.status === 422) return '配置未被接受，请检查模型名称和 API Key 后重新填写。';
    if (error?.status === 429) return '检测过于频繁，请稍后重试。';
    if (error?.status === 503) return '当前环境暂时无法完成此操作，请检查平台设置或稍后重试。';
    return action === 'test' ? '平台未能完成检测，不能据此判断 DeepSeek 是否在线。请稍后重试。' : '平台未能保存配置，请稍后重试。';
  }
  async function refresh({ reviewConflict = false } = {}) {
    if (reading || busy || destroyed) return;
    reading = true;
    const startedAtEpoch = epoch;
    render();
    try {
      const value = await api('/api/provider');
      if (destroyed || startedAtEpoch !== epoch) return;
      accept(value, { reviewConflict });
    } catch {
      if (destroyed || startedAtEpoch !== epoch) return;
      unavailable = true;
      render();
    } finally {
      reading = false;
      if (!destroyed) { render(); maybeAutoTest(); }
    }
  }
  async function test(force = true) {
    if (!current?.configured || current.source === 'disabled' || unavailable || busy || dirty() || conflict || destroyed) return;
    const revision = current.revision;
    autoAttempts.add(checkToken());
    busy = 'test';
    epoch += 1;
    render();
    if (force) message('正在检测当前已保存配置…');
    try {
      const value = await api('/api/provider/test', { method: 'POST', body: { revision, force } });
      if (destroyed) return;
      accept(value);
      if (force && dialog.open) message(value.discarded ? '检测期间配置发生变化，旧检测结果已弃用；请查看最新状态。' : `检测完成：${status().label}。`, status().tone === 'warning' ? 'warning' : '');
    } catch (error) {
      if (destroyed) return;
      if (error?.status === 409) { conflict = Boolean(dialog.open && baseline); conflictReviewed = false; }
      unavailable = true;
      if (dialog.open) message(safeFailure(error, 'test'), 'warning');
    } finally {
      busy = '';
      if (!destroyed) render();
    }
  }
  function maybeAutoTest() {
    if (document.visibilityState !== 'visible' || !current?.configured || current.source === 'disabled' || unavailable || busy || dirty() || conflict) return;
    if ((!current.lastCheck || expired()) && !autoAttempts.has(checkToken())) void test(false);
  }
  async function mutate(action) {
    if (!current || !baseline || unavailable || busy || conflict || destroyed) return;
    const body = { revision: baseline.revision, action };
    if (action === 'save') {
      if (!current.manualConfigAvailable) return;
      const model = modelInput.value.trim();
      if (!MODEL_PATTERN.test(model)) { message('模型名称须以 deepseek- 开头，后接 1–64 位小写字母、数字、点或连字符。', 'error'); modelInput.focus(); return; }
      if (!keyInput.value.trim() && !current.configured && !current.hasSavedKey) { message('尚未配置有效密钥，请输入 API Key，或点击恢复默认。', 'error'); keyInput.focus(); return; }
      body.model = model;
      if (keyInput.value.trim()) body.apiKey = keyInput.value.trim();
    }
    busy = action;
    epoch += 1;
    render();
    let keepDraftKey = false;
    try {
      const value = await api('/api/provider', { method: 'PATCH', body });
      if (destroyed) return;
      accept(value, { resetEditor: true });
      message(action === 'save' ? '配置已保存，将用于后续分析。' : action === 'default' ? '已恢复本环境默认配置。' : '当前账号已停用 DeepSeek。');
    } catch (error) {
      if (destroyed) return;
      if (error?.status === 409) { conflict = true; conflictReviewed = false; keepDraftKey = true; }
      message(safeFailure(error, action), 'error');
    } finally {
      if (!keepDraftKey) keyInput.value = '';
      delete body.apiKey;
      busy = '';
      if (!destroyed) { render(); maybeAutoTest(); }
    }
  }
  async function open() {
    if (dialog.open) return;
    message('');
    keyInput.value = '';
    baseline = null;
    conflict = false;
    conflictReviewed = false;
    dialog.showModal();
    hydrate();
    render();
    await refresh();
  }
  function close() {
    keyInput.value = '';
    baseline = null;
    conflict = false;
    conflictReviewed = false;
    message('');
    render();
  }
  const beforeUnload = (event) => {
    if (dirty() || busy === 'save' || busy === 'default' || busy === 'disable') { event.preventDefault(); event.returnValue = ''; }
  };
  const visible = () => { render(); if (document.visibilityState === 'visible') void refresh(); };
  $('provider-open').addEventListener('click', open);
  $('provider-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', close);
  dialog.addEventListener('cancel', () => { keyInput.value = ''; });
  $('provider-form').addEventListener('submit', (event) => { event.preventDefault(); void mutate('save'); });
  $('provider-test').addEventListener('click', () => void test(true));
  $('provider-default').addEventListener('click', () => void mutate('default'));
  $('provider-disable').addEventListener('click', () => void mutate('disable'));
  $('provider-refresh').addEventListener('click', () => void refresh({ reviewConflict: true }));
  $('provider-rebase').addEventListener('click', () => {
    if (!conflict || !conflictReviewed || !current || unavailable || busy) return;
    baseline = { revision: current.revision, model: current.model };
    conflict = false;
    conflictReviewed = false;
    message('已采用最新配置版本，填写内容仍保留。请检查后点击保存配置。');
    render();
  });
  keyInput.addEventListener('input', render);
  modelInput.addEventListener('input', render);
  window.addEventListener('beforeunload', beforeUnload);
  document.addEventListener('visibilitychange', visible);
  // Refreshing platform metadata does not call DeepSeek; stale probes are deduplicated separately.
  const timer = window.setInterval(() => {
    render();
    if (document.visibilityState === 'visible') void refresh();
  }, 60 * 1000);
  render();
  void refresh();
  return {
    refresh,
    destroy() {
      destroyed = true;
      keyInput.value = '';
      window.clearInterval(timer);
      window.clearTimeout(expiryTimer);
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('visibilitychange', visible);
    },
  };
}

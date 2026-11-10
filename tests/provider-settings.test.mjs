import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStorage } from '../src/local-storage.mjs';
import { getProviderStatus, handleProviderAPI, resolveProviderEnvironment } from '../src/provider-settings.js';

const ORIGIN = 'https://provider.example';
const MASTER = Buffer.alloc(32, 19).toString('base64');
const DUMMY_KEY = 'sk-dummy-provider-settings-key';
const RUNTIME_KEY = 'sk-dummy-runtime-key';
let sequence = 0;
async function setup(t, extra = {}) {
  const storage = await createLocalStorage({ memory: true });
  t.after(() => storage.close());
  return { env: { ...storage, AI_CONFIG_ENCRYPTION_KEY: MASTER, ...extra }, owner: `provider-test-${++sequence}` };
}
function request(owner, { method = 'GET', path = '/api/provider', body, headers = {} } = {}) {
  return new Request(ORIGIN + path, { method, headers: { Origin: ORIGIN, ...(owner ? { 'oai-authenticated-user-id': owner } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function call(env, owner, init, options) { return handleProviderAPI(request(owner, init), env, options); }
async function value(env, owner, init, options) { const response = await call(env, owner, init, options); assert.equal(response.status, 200); return response.json(); }
function save(env, owner, revision, values = {}, options) { return call(env, owner, { method: 'PATCH', body: { revision, action: 'save', ...values } }, options); }
function models(model = 'deepseek-flash', extra = {}) { return new Response(JSON.stringify({ data: [{ id: model, ...extra }] }), { headers: { 'Content-Type': 'application/json' } }); }
function check(env, owner, revision, options, force = false) { return call(env, owner, { path: '/api/provider/test', method: 'POST', body: { revision, force } }, options); }
async function row(env, owner) { return env.DB.prepare('SELECT * FROM recovery_provider_settings WHERE owner_id = ?').bind(owner).first(); }

test('provider settings require identity/storage/same origin and reject arbitrary fields and oversized input', async (t) => {
  const { env, owner } = await setup(t);
  assert.equal((await call(env, '')).status, 401);
  assert.equal((await call({}, owner)).status, 503);
  assert.equal((await call(env, owner, { headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await call(env, owner, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await call(env, owner, { method: 'POST' })).status, 405);
  assert.equal((await call(env, owner, { path: '/api/provider/other' })).status, 404);
  assert.equal((await save(env, owner, 0, { apiKey: DUMMY_KEY, endpoint: 'https://other.example' })).status, 400);
  assert.equal((await save(env, owner, 0, { apiKey: DUMMY_KEY, model: 'other-provider' })).status, 400);
  assert.equal((await save(env, owner, 0, { apiKey: 'dummy key with spaces' })).status, 400);
  assert.equal((await save(env, owner, 0, { apiKey: 'x'.repeat(8500) })).status, 413);
  assert.equal((await save(env, owner, 0)).status, 400);
  assert.equal((await check(env, owner, 0, {}, true)).status, 200);
  assert.equal((await call(env, owner, { path: '/api/provider/test', method: 'POST', body: { revision: 0, apiKey: DUMMY_KEY } })).status, 400);
  assert.equal(await row(env, owner).then((entry) => entry.revision), 0, 'a check does not advance configuration revision');
});

test('saved credentials are encrypted at rest, safely reported and isolated to their authenticated owner', async (t) => {
  const { env, owner } = await setup(t);
  const initial = await value(env, owner);
  assert.equal(initial.revision, 0); assert.equal(initial.configured, false); assert.equal(initial.manualConfigAvailable, true);
  const response = await save(env, owner, 0, { apiKey: DUMMY_KEY, model: 'deepseek-flash' });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.revision, 1); assert.equal(saved.source, 'saved'); assert.equal(saved.configured, true); assert.equal(saved.hasSavedKey, true);
  const stored = await row(env, owner);
  assert.equal(stored.mode, 'custom'); assert.ok(stored.ciphertext); assert.ok(stored.iv);
  assert.equal(JSON.stringify(stored).includes(DUMMY_KEY), false);
  assert.equal(JSON.stringify(saved).includes(DUMMY_KEY), false);
  assert.equal(JSON.stringify(saved).includes(stored.ciphertext), false);
  assert.equal(JSON.stringify(saved).includes('fingerprint'), false);
  const resolved = await resolveProviderEnvironment(request(owner), env);
  assert.equal(resolved.DEEPSEEK_API_KEY, DUMMY_KEY); assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal((await value(env, owner + '-other')).configured, false);
  assert.equal((await resolveProviderEnvironment(request(owner + '-other'), env)).DEEPSEEK_API_KEY, '');
  const modelChange = await save(env, owner, 1, { apiKey: '', model: 'deepseek-reasoner' });
  assert.equal(modelChange.status, 200);
  assert.equal((await resolveProviderEnvironment(request(owner), env)).DEEPSEEK_API_KEY, DUMMY_KEY);
  assert.equal((await row(env, owner)).ciphertext, stored.ciphertext, 'owner AAD permits ciphertext retention for model-only saves');
});

test('owner-bound authenticated encryption and tampering fail closed without runtime key fallback', async (t) => {
  const { env, owner } = await setup(t, { DEEPSEEK_API_KEY: RUNTIME_KEY });
  const other = owner + '-other';
  await save(env, owner, 0, { apiKey: DUMMY_KEY });
  await save(env, other, 0, { apiKey: 'sk-dummy-other-provider-key' });
  const original = await row(env, owner);
  await env.DB.prepare('UPDATE recovery_provider_settings SET ciphertext = ?, iv = ? WHERE owner_id = ?').bind(original.ciphertext, original.iv, other).run();
  const copied = await value(env, other);
  assert.equal(copied.configured, false); assert.equal(copied.source, 'saved'); assert.equal(copied.configurationError, 'saved_key_unreadable');
  await assert.rejects(resolveProviderEnvironment(request(other), env), { status: 503 });
  const altered = (original.ciphertext[0] === 'A' ? 'B' : 'A') + original.ciphertext.slice(1);
  await env.DB.prepare('UPDATE recovery_provider_settings SET ciphertext = ? WHERE owner_id = ?').bind(altered, owner).run();
  assert.equal((await value(env, owner)).configurationError, 'saved_key_unreadable');
  await assert.rejects(resolveProviderEnvironment(request(owner), env), { status: 503 });
  assert.equal((await save(env, owner, 1, { model: 'deepseek-reasoner' })).status, 503);
  assert.equal((await save(env, owner, 1, { apiKey: 'sk-dummy-replacement' })).status, 200);
  assert.equal((await resolveProviderEnvironment(request(owner), env)).DEEPSEEK_API_KEY, 'sk-dummy-replacement');
});

test('default inheritance, model-only runtime override, disable and restore never persist a runtime secret', async (t) => {
  const { env, owner } = await setup(t, { DEEPSEEK_API_KEY: RUNTIME_KEY, DEEPSEEK_MODEL: 'deepseek-reasoner' });
  assert.equal((await value(env, owner)).source, 'environment');
  assert.equal((await save(env, owner, 0, { apiKey: '', model: 'deepseek-flash' })).status, 200);
  const stored = await row(env, owner);
  assert.equal(stored.mode, 'default'); assert.equal(stored.model, 'deepseek-flash'); assert.equal(stored.ciphertext, null);
  assert.equal(JSON.stringify(stored).includes(RUNTIME_KEY), false);
  let resolved = await resolveProviderEnvironment(request(owner), env);
  assert.equal(resolved.DEEPSEEK_API_KEY, RUNTIME_KEY); assert.equal(resolved.DEEPSEEK_MODEL, 'deepseek-flash');
  const disabled = await value(env, owner, { method: 'PATCH', body: { revision: 1, action: 'disable' } });
  assert.equal(disabled.source, 'disabled'); assert.equal(disabled.configured, false); assert.equal(disabled.hasSavedKey, false);
  assert.equal(disabled.model, 'deepseek-flash', 'disabling preserves a model override');
  resolved = await resolveProviderEnvironment(request(owner), env); assert.equal(resolved.DEEPSEEK_API_KEY, '');
  const restored = await value(env, owner, { method: 'PATCH', body: { revision: 2, action: 'default' } });
  assert.equal(restored.source, 'environment'); assert.equal(restored.model, 'deepseek-reasoner'); assert.equal((await row(env, owner)).model, '');
  assert.equal((await call(env, owner, { method: 'PATCH', body: { revision: 3, action: 'default', apiKey: DUMMY_KEY } })).status, 400);
});

test('disable pauses an encrypted custom key and blank-key save restores the same model and credential', async (t) => {
  const { env, owner } = await setup(t, { DEEPSEEK_API_KEY: RUNTIME_KEY });
  await save(env, owner, 0, { apiKey: DUMMY_KEY, model: 'deepseek-reasoner' });
  const stored = await row(env, owner);
  const paused = await value(env, owner, { method: 'PATCH', body: { revision: 1, action: 'disable' } });
  assert.equal(paused.source, 'disabled'); assert.equal(paused.configured, false); assert.equal(paused.hasSavedKey, true); assert.equal(paused.model, 'deepseek-reasoner');
  assert.doesNotMatch(JSON.stringify(paused), /sk-dummy|ciphertext|fingerprint|"iv"/);
  const disabledRow = await row(env, owner);
  assert.equal(disabledRow.ciphertext, stored.ciphertext); assert.equal(disabledRow.iv, stored.iv); assert.equal(disabledRow.model, stored.model);
  assert.equal(JSON.stringify(disabledRow).includes(DUMMY_KEY), false);
  assert.equal((await resolveProviderEnvironment(request(owner), env)).DEEPSEEK_API_KEY, '');
  const enabled = await value(env, owner, { method: 'PATCH', body: { revision: 2, action: 'save', apiKey: '' } });
  assert.equal(enabled.source, 'saved'); assert.equal(enabled.configured, true); assert.equal(enabled.hasSavedKey, true); assert.equal(enabled.model, 'deepseek-reasoner');
  assert.equal((await resolveProviderEnvironment(request(owner), env)).DEEPSEEK_API_KEY, DUMMY_KEY);
  assert.equal((await row(env, owner)).ciphertext, stored.ciphertext);
});

test('a corrupt disabled key cannot reactivate but can be replaced or explicitly removed by restoring defaults', async (t) => {
  const { env, owner } = await setup(t, { DEEPSEEK_API_KEY: RUNTIME_KEY });
  await save(env, owner, 0, { apiKey: DUMMY_KEY, model: 'deepseek-reasoner' });
  await value(env, owner, { method: 'PATCH', body: { revision: 1, action: 'disable' } });
  await env.DB.prepare('UPDATE recovery_provider_settings SET ciphertext = ? WHERE owner_id = ?').bind('corrupt-ciphertext', owner).run();
  assert.equal((await value(env, owner)).source, 'disabled');
  assert.equal((await resolveProviderEnvironment(request(owner), env)).DEEPSEEK_API_KEY, '');
  assert.equal((await save(env, owner, 2, { apiKey: '' })).status, 503);
  const missingMaster = { ...env, AI_CONFIG_ENCRYPTION_KEY: undefined };
  const restored = await value(missingMaster, owner, { method: 'PATCH', body: { revision: 2, action: 'default' } });
  assert.equal(restored.source, 'environment'); assert.equal(restored.hasSavedKey, false); assert.equal(restored.model, 'deepseek-flash');
  assert.equal((await row(env, owner)).ciphertext, null);
  await save(env, owner, 3, { apiKey: DUMMY_KEY });
  await value(env, owner, { method: 'PATCH', body: { revision: 4, action: 'disable' } });
  assert.equal((await save(env, owner, 5, { apiKey: 'sk-dummy-new-after-pause' })).status, 200);
  assert.equal((await resolveProviderEnvironment(request(owner), env)).DEEPSEEK_API_KEY, 'sk-dummy-new-after-pause');
});

test('missing encryption setup supports runtime inheritance but refuses new secrets and protects saved secrets', async (t) => {
  const { env, owner } = await setup(t, { DEEPSEEK_API_KEY: RUNTIME_KEY });
  const unconfigured = { ...env, AI_CONFIG_ENCRYPTION_KEY: undefined };
  assert.equal((await value(unconfigured, owner)).manualConfigAvailable, false);
  assert.equal((await resolveProviderEnvironment(request(owner), unconfigured)).DEEPSEEK_API_KEY, RUNTIME_KEY);
  assert.equal((await save(unconfigured, owner, 0, { apiKey: DUMMY_KEY })).status, 503);
  assert.equal(await row(env, owner), null);
  assert.equal((await save(env, owner, 0, { apiKey: DUMMY_KEY })).status, 200);
  assert.equal((await value(unconfigured, owner)).configurationError, 'encryption_unavailable');
  await assert.rejects(resolveProviderEnvironment(request(owner), unconfigured), { status: 503 });
  assert.equal((await value(unconfigured, owner, { method: 'PATCH', body: { revision: 1, action: 'default' } })).configured, true);
  assert.equal(await resolveProviderEnvironment(request(''), env), env, 'legacy requests without owner remain compatible');
  const legacy = { DEEPSEEK_API_KEY: DUMMY_KEY };
  assert.equal(await resolveProviderEnvironment(request(owner), legacy), legacy, 'legacy requests without DB remain compatible');
  assert.equal((await getProviderStatus(null, env, { localOwnerId: owner })).source, 'environment');
});

test('configuration writes compare-and-swap from missing rows and reject stale revisions', async (t) => {
  const { env, owner } = await setup(t);
  const responses = await Promise.all([save(env, owner, 0, { apiKey: DUMMY_KEY }), save(env, owner, 0, { apiKey: 'sk-dummy-competing-key' })]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await row(env, owner)).revision, 1);
  assert.equal((await save(env, owner, 0, { apiKey: DUMMY_KEY })).status, 409);
  assert.equal((await check(env, owner, 0)).status, 409);
  const responses2 = await Promise.all([save(env, owner, 1, { model: 'deepseek-reasoner' }), call(env, owner, { method: 'PATCH', body: { revision: 1, action: 'disable' } })]);
  assert.deepEqual(responses2.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await row(env, owner)).revision, 2);
});

test('a first configuration save can replace a concurrently inserted revision-zero probe row', async (t) => {
  const { env, owner } = await setup(t);
  const db = env.DB;
  let injected = false;
  const wrapped = { ...env, DB: { prepare(sql) {
    const statement = db.prepare(sql);
    if (!sql.includes('ON CONFLICT(owner_id) DO UPDATE')) return statement;
    return { bind(...values) {
      const bound = statement.bind(...values);
      return { async run() {
        injected = true;
        await db.prepare('INSERT INTO recovery_provider_settings (owner_id, revision, mode, model, updated_at) VALUES (?, 0, ?, ?, ?)').bind(owner, 'default', '', new Date().toISOString()).run();
        return bound.run();
      } };
    } };
  } } };
  assert.equal((await save(wrapped, owner, 0, { apiKey: DUMMY_KEY })).status, 200);
  assert.equal(injected, true); assert.equal((await row(env, owner)).revision, 1);
  assert.equal((await resolveProviderEnvironment(request(owner), env)).DEEPSEEK_API_KEY, DUMMY_KEY);
});

test('GET never probes; explicit saved checks cache safely, grow stale and invalidate on environment key rotation', async (t) => {
  const { env, owner } = await setup(t, { DEEPSEEK_API_KEY: RUNTIME_KEY });
  let at = Date.parse('2026-11-10T09:00:00Z'); let calls = 0;
  const options = { now: () => at, fetchImpl: async (url, init) => {
    calls += 1; assert.equal(url, 'https://api.deepseek.com/models'); assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit'); assert.equal(init.headers.Authorization, `Bearer ${env.DEEPSEEK_API_KEY}`);
    assert.equal(init.body, undefined); return models('deepseek-flash', { input_modalities: ['text', 'image'] });
  } };
  assert.equal((await value(env, owner, {}, options)).lastCheck, null); assert.equal(calls, 0);
  const checked = await check(env, owner, 0, options).then((response) => response.json());
  assert.equal(checked.lastCheck.status, 'online'); assert.equal(checked.lastCheck.supportsImages, true); assert.equal(checked.revision, 0);
  assert.equal((await row(env, owner)).revision, 0); assert.equal((await row(env, owner)).ciphertext, null);
  assert.doesNotMatch(JSON.stringify(checked), /sk-dummy|fingerprint|ciphertext|Bearer/);
  at += 1000;
  const cached = await check(env, owner, 0, options).then((response) => response.json());
  assert.equal(cached.cached, true); assert.equal(calls, 1);
  assert.equal((await check(env, owner, 0, options, true)).status, 429);
  at += 5 * 60 * 1000;
  assert.equal((await value(env, owner, {}, options)).stale, true); assert.equal(calls, 1);
  env.DEEPSEEK_API_KEY = 'sk-dummy-rotated-runtime-key';
  const rotated = await value(env, owner, {}, options);
  assert.equal(rotated.lastCheck, null); assert.equal(rotated.stale, true);
  assert.equal((await check(env, owner, 0, options)).status, 200); assert.equal(calls, 2);
  assert.equal((await save(env, owner, 0, { model: 'deepseek-reasoner' }, options)).status, 200);
  assert.equal((await value(env, owner, {}, options)).lastCheck, null);
});

test('in-flight probes cannot mark changed models or rotated runtime keys online', async (t) => {
  const { env, owner } = await setup(t, { DEEPSEEK_API_KEY: RUNTIME_KEY });
  let release; let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { started = resolve; });
  const pending = check(env, owner, 0, { fetchImpl: async () => { started(); await gate; return models(); } });
  await ready;
  assert.equal((await save(env, owner, 0, { model: 'deepseek-reasoner' })).status, 200);
  release();
  const result = await (await pending).json();
  assert.equal(result.discarded, true); assert.equal(result.model, 'deepseek-reasoner'); assert.equal(result.lastCheck, null);
  const other = owner + '-rotated';
  let release2; let started2;
  const gate2 = new Promise((resolve) => { release2 = resolve; }); const ready2 = new Promise((resolve) => { started2 = resolve; });
  const pending2 = check(env, other, 0, { fetchImpl: async () => { started2(); await gate2; return models(); } });
  await ready2; env.DEEPSEEK_API_KEY = 'sk-dummy-key-rotated-during-check'; release2();
  const result2 = await (await pending2).json();
  assert.equal(result2.discarded, true); assert.equal(result2.lastCheck, null); assert.equal(await row(env, other), null);
});

test('disabled and unconfigured checks make no provider calls; concurrent owner/global checks are bounded', async (t) => {
  const { env, owner } = await setup(t);
  const noFetch = { fetchImpl: async () => { assert.fail('no external call expected'); } };
  const empty = await check(env, owner, 0, noFetch).then((response) => response.json()); assert.equal(empty.lastCheck.status, 'not_configured');
  await call(env, owner, { method: 'PATCH', body: { revision: 0, action: 'disable' } });
  const disabled = await check(env, owner, 1, noFetch).then((response) => response.json()); assert.equal(disabled.lastCheck.status, 'disabled');
  const keyed = { ...env, DEEPSEEK_API_KEY: RUNTIME_KEY };
  let release; let reached = 0; let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { started = resolve; });
  const options = { fetchImpl: async () => { if (++reached === 2) started(); await gate; return models(); } };
  const one = check(keyed, owner + '-one', 0, options); const two = check(keyed, owner + '-two', 0, options);
  await ready;
  assert.equal((await check(keyed, owner + '-one', 0, options)).status, 429);
  assert.equal((await check(keyed, owner + '-three', 0, options)).status, 429);
  release(); assert.equal((await one).status, 200); assert.equal((await two).status, 200);
});

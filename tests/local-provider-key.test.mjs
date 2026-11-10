import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadLocalProviderKey } from '../src/local-provider-key.mjs';

const MODULE_URL = new URL('../src/local-provider-key.mjs', import.meta.url).href;
const DUMMY_KEY = Buffer.alloc(32, 19).toString('base64');
const DUMMY_OTHER_KEY = Buffer.alloc(32, 23).toString('base64');
const ENV_ERROR = 'AI_CONFIG_ENCRYPTION_KEY must contain a base64-encoded 32-byte key.';
const LOAD_ERROR = 'Unable to load the local AI encryption key. Check the AI_CONFIG_ENCRYPTION_KEY setting or restore the existing local master key.';
const masterFilename = (directory, platform = process.platform) => path.join(directory, platform === 'win32' ? 'provider-master.xml' : 'provider-master.key');

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'local-provider-key-test-'));
  t.after(async () => {
    const temporaryRoot = path.resolve(tmpdir());
    const target = path.resolve(directory);
    assert.ok(target.startsWith(temporaryRoot + path.sep) && target !== temporaryRoot, 'Cleanup stays inside the test temporary directory.');
    await rm(target, { recursive: true, force: true });
  });
  return directory;
}

function errorIs(expected, forbidden = []) {
  return (error) => {
    assert.ok(error instanceof Error, 'The operation returns an Error.');
    assert.ok(error.message === expected, 'The error uses the generic expected message.');
    for (const value of forbidden) assert.ok(!String(error.stack).includes(value), 'The error does not expose input or subprocess output.');
    assert.ok(error.cause === undefined, 'The error does not retain a secret-bearing cause.');
    return true;
  };
}

// Separate Node processes verify persistence and first-start races. Only a
// digest leaves the child; generated dummy master keys are never logged.
function loadInProcess(directory) {
  return new Promise((resolve, reject) => {
    const script = `import { createHash } from 'node:crypto';
      import { loadLocalProviderKey } from ${JSON.stringify(MODULE_URL)};
      try {
        const key = await loadLocalProviderKey({ directory: process.argv[1], env: {} });
        process.stdout.write(createHash('sha256').update(key).digest('hex'));
      } catch { process.exitCode = 1; }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', () => reject(new Error('The isolated test process could not start.')));
    child.on('close', (code) => {
      if (code === 0 && /^[a-f0-9]{64}$/.test(output)) resolve(output);
      else reject(new Error('The isolated test process could not load its dummy master key.'));
    });
  });
}

function protectDummyMaster(filename, key) {
  return new Promise((resolve, reject) => {
    const script = `$ErrorActionPreference = 'Stop'; try {
      $payload = ($input | Out-String) | ConvertFrom-Json
      ConvertTo-SecureString -String ([string]$payload.key) -AsPlainText -Force | Export-Clixml -LiteralPath ([string]$payload.path) -Encoding UTF8
    } catch { exit 1 }`;
    const executable = path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())));
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env });
    child.on('error', () => reject(new Error('The protected dummy fixture could not be created.')));
    child.stdin.on('error', () => reject(new Error('The protected dummy fixture could not be created.')));
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('The protected dummy fixture could not be created.')));
    child.stdin.end(JSON.stringify({ path: filename, key }), 'utf8');
  });
}

test('an explicit valid environment key takes precedence without creating files', async (t) => {
  const directory = await fixture(t);
  const filename = masterFilename(directory);
  await writeFile(filename, 'an existing unreadable master must not be touched', { mode: 0o600 });
  const before = await readFile(filename, 'utf8');
  const key = await loadLocalProviderKey({ directory, env: { AI_CONFIG_ENCRYPTION_KEY: DUMMY_KEY } });
  assert.ok(key === DUMMY_KEY, 'The configured key is returned unchanged.');
  assert.ok(await readFile(filename, 'utf8') === before, 'Environment precedence leaves the existing file unchanged.');
  const absent = path.join(directory, 'must-not-be-created');
  await loadLocalProviderKey({ directory: absent, env: { AI_CONFIG_ENCRYPTION_KEY: DUMMY_KEY } });
  await assert.rejects(stat(absent), (error) => error.code === 'ENOENT');
});

test('invalid environment keys fail without falling back to disk or exposing values', async (t) => {
  const directory = await fixture(t);
  const noncanonical = Buffer.alloc(32).toString('base64').slice(0, -2) + 'B=';
  for (const value of ['', 'sensitive-invalid-dummy-value', DUMMY_KEY + '\n', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), noncanonical, null, 123]) {
    await assert.rejects(loadLocalProviderKey({ directory, env: { AI_CONFIG_ENCRYPTION_KEY: value } }), errorIs(ENV_ERROR, typeof value === 'string' && value ? [value] : []));
  }
  assert.ok((await readdir(directory)).length === 0, 'Invalid configuration does not write local files.');
});

test('the generated master is stable across calls and fresh Node processes', async (t) => {
  const directory = await fixture(t);
  const first = await loadLocalProviderKey({ directory, env: {} });
  const second = await loadLocalProviderKey({ directory, env: {} });
  assert.ok(/^[A-Za-z0-9+/]{43}=$/.test(first) && Buffer.from(first, 'base64').length === 32, 'The master is exactly 32 bytes of canonical base64.');
  assert.ok(first === second, 'Repeated loads use the same master.');
  const beforeRestart = await loadInProcess(directory);
  const afterRestart = await loadInProcess(directory);
  assert.ok(beforeRestart === afterRestart, 'Restarted processes load the same persisted master.');
  assert.ok((await readdir(directory)).length === 1, 'No temporary master files remain.');
});

test('simultaneous first starts publish one master and every process uses it', async (t) => {
  const directory = await fixture(t);
  const digests = await Promise.all(Array.from({ length: 4 }, () => loadInProcess(directory)));
  assert.ok(digests.every((digest) => digest === digests[0]), 'All concurrent processes use the winning master.');
  assert.ok((await readdir(directory)).length === 1, 'Atomic publication removes losing temporary files.');
});

test('a corrupt existing master fails closed and is never replaced', async (t) => {
  const directory = await fixture(t);
  const filename = masterFilename(directory);
  const corrupt = 'sensitive-corrupt-dummy-master';
  await writeFile(filename, corrupt, { mode: 0o600 });
  await assert.rejects(loadLocalProviderKey({ directory, env: {} }), errorIs(LOAD_ERROR, [corrupt]));
  assert.ok(await readFile(filename, 'utf8') === corrupt, 'The corrupt existing master is preserved for recovery.');
  assert.ok((await readdir(directory)).length === 1, 'Failure does not generate a replacement master.');
});

test('empty and oversized master files fail closed', async (t) => {
  const directory = await fixture(t);
  const filename = masterFilename(directory);
  for (const value of ['', 'x'.repeat(16 * 1024 + 1)]) {
    await writeFile(filename, value, { mode: 0o600 });
    await assert.rejects(loadLocalProviderKey({ directory, env: {} }), errorIs(LOAD_ERROR));
    assert.ok(await readFile(filename, 'utf8') === value, 'An invalid existing file remains unchanged.');
  }
});

test('Windows stores a CurrentUser DPAPI SecureString without cleartext master data', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await fixture(t);
  const key = await loadLocalProviderKey({ directory, env: {} });
  const xml = await readFile(masterFilename(directory), 'utf8');
  assert.ok(xml.includes('<SS>') && xml.includes('01000000d08c9ddf'), 'The XML contains DPAPI protected SecureString data.');
  assert.ok(!xml.includes(key), 'The master base64 is absent from the XML.');
  assert.ok(!xml.includes(Buffer.from(key, 'utf16le').toString('hex')), 'The master is not serialized as unencrypted SecureString character data.');
  assert.ok(!(await readdir(directory)).includes('provider-master.key'), 'Windows never creates a plaintext fallback.');
});

test('Windows rejects decrypted values with an invalid master length without exposing them', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await fixture(t);
  const filename = masterFilename(directory);
  const invalid = Buffer.alloc(31, 11).toString('base64');
  await protectDummyMaster(filename, invalid);
  const before = await readFile(filename, 'utf8');
  await assert.rejects(loadLocalProviderKey({ directory, env: {} }), errorIs(LOAD_ERROR, [invalid]));
  assert.ok(await readFile(filename, 'utf8') === before, 'A decryptable but invalid existing master is preserved.');
});

test('the non-Windows fallback is stable and has private file permissions', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await fixture(t);
  const key = await loadLocalProviderKey({ directory, env: {} });
  const filename = masterFilename(directory);
  assert.ok((await stat(filename)).mode % 0o1000 === 0o600, 'The fallback master file has mode 0600.');
  assert.ok(await readFile(filename, 'utf8') === key, 'The documented private fallback holds the stable master.');
  const fromEnvironment = await loadLocalProviderKey({ directory, env: { AI_CONFIG_ENCRYPTION_KEY: DUMMY_OTHER_KEY } });
  assert.ok(fromEnvironment === DUMMY_OTHER_KEY, 'An explicit key still overrides the fallback.');
});

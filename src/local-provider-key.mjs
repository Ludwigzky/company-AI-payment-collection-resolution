import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIRECTORY = fileURLToPath(new URL('../.local-data/', import.meta.url));
const MAX_MASTER_FILE_BYTES = 16 * 1024;
const LOAD_ERROR = 'Unable to load the local AI encryption key. Check the AI_CONFIG_ENCRYPTION_KEY setting or restore the existing local master key.';
const ENV_ERROR = 'AI_CONFIG_ENCRYPTION_KEY must contain a base64-encoded 32-byte key.';

// The command is fixed. Both the filename and the secret travel through stdin,
// never command-line arguments, environment variables, or PowerShell source.
// Export-Clixml protects SecureString with DPAPI for the current Windows user.
const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $payload = ($input | Out-String) | ConvertFrom-Json
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  if ($payload.operation -eq 'protect') {
    $secure = ConvertTo-SecureString -String ([string]$payload.key) -AsPlainText -Force
    $secure | Export-Clixml -LiteralPath ([string]$payload.path) -Encoding UTF8
  } elseif ($payload.operation -eq 'unprotect') {
    $secure = Import-Clixml -LiteralPath ([string]$payload.path)
    if ($secure -isnot [System.Security.SecureString]) { throw 'Invalid key store.' }
    $credential = [System.Net.NetworkCredential]::new('', $secure)
    [Console]::Out.Write($credential.Password)
  } else {
    throw 'Invalid operation.'
  }
} catch {
  exit 1
}
`;

function validMasterKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  try { return decoded.length === 32 && decoded.toString('base64') === value; }
  finally { decoded.fill(0); }
}

function windowsEnvironment() {
  // The subprocess does not need application credentials inherited by Node.
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())));
}

function dpapi(payload) {
  return new Promise((resolve, reject) => {
    const executable = path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let child;
    try {
      child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: windowsEnvironment(),
      });
    } catch { reject(new Error(LOAD_ERROR)); return; }
    const chunks = [];
    let bytes = 0;
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      child.kill();
      for (const chunk of chunks) chunk.fill(0);
      reject(new Error(LOAD_ERROR));
    };
    const timer = setTimeout(fail, 15_000);
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', (chunk) => {
      if (failed) { chunk.fill(0); return; }
      bytes += chunk.length;
      if (bytes > 1024) { chunk.fill(0); fail(); return; }
      chunks.push(chunk);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) { fail(); return; }
      const output = Buffer.concat(chunks);
      try { resolve(output.toString('utf8')); }
      finally { output.fill(0); for (const chunk of chunks) chunk.fill(0); }
    });
    child.stdin.end(JSON.stringify(payload), 'utf8');
  });
}

async function checkMasterFile(filename, platform) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_MASTER_FILE_BYTES) throw new Error(LOAD_ERROR);
  if (platform !== 'win32' && (metadata.mode & 0o077) !== 0) throw new Error(LOAD_ERROR);
}

async function readMaster(filename, platform) {
  await checkMasterFile(filename, platform);
  const key = platform === 'win32'
    ? await dpapi({ operation: 'unprotect', path: filename })
    : await readFile(filename, 'utf8');
  if (!validMasterKey(key)) throw new Error(LOAD_ERROR);
  return key;
}

/**
 * Load the stable local key used to encrypt manually configured AI credentials.
 * Windows stores only a CurrentUser-DPAPI SecureString in provider-master.xml.
 * Other platforms use a raw provider-master.key protected by mode 0600 inside a
 * mode 0700 directory; supply AI_CONFIG_ENCRYPTION_KEY for managed deployments.
 * Existing files are never overwritten or regenerated when they cannot be read.
 */
export async function loadLocalProviderKey({ directory = DEFAULT_DIRECTORY, env = process.env, platform = process.platform } = {}) {
  const configured = env?.AI_CONFIG_ENCRYPTION_KEY;
  if (configured !== undefined) {
    if (!validMasterKey(configured)) throw new Error(ENV_ERROR);
    return configured;
  }
  try {
    const resolvedDirectory = path.resolve(directory);
    const filename = path.join(resolvedDirectory, platform === 'win32' ? 'provider-master.xml' : 'provider-master.key');
    await mkdir(resolvedDirectory, { recursive: true, mode: 0o700 });
    try { return await readMaster(filename, platform); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }

    const temporary = path.join(resolvedDirectory, `.provider-master-${randomBytes(16).toString('hex')}.tmp`);
    const bytes = randomBytes(32);
    let temporaryFile;
    try {
      const key = bytes.toString('base64');
      temporaryFile = await open(temporary, 'wx', 0o600);
      if (platform === 'win32') {
        await temporaryFile.close();
        temporaryFile = undefined;
        await dpapi({ operation: 'protect', path: temporary, key });
      } else {
        await temporaryFile.writeFile(key, 'utf8');
        await temporaryFile.sync();
        await temporaryFile.close();
        temporaryFile = undefined;
      }
      await checkMasterFile(temporary, platform);
      // A hard link publishes an already complete file atomically, without
      // overwriting a winner created by another simultaneous server process.
      try { await link(temporary, filename); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally {
      bytes.fill(0);
      if (temporaryFile) await temporaryFile.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
    return await readMaster(filename, platform);
  } catch { throw new Error(LOAD_ERROR); }
}

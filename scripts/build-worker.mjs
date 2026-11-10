import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicAssets = ['index.html', 'styles.css', 'app.js', 'overview.js', 'engine.js', 'sources.js', 'favicon.svg'];
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const assets = Object.fromEntries(await Promise.all(publicAssets.map(async (file) => [
  '/' + file,
  { content: await readFile(path.join(root, 'dist', file), 'utf8'), type: types[path.extname(file)] },
])));
const hosting = JSON.parse(await readFile(path.join(root, '.openai/hosting.json'), 'utf8'));
if (!hosting.project_id || hosting.static) throw new Error('Worker hosting manifest must retain the Site id and omit static configuration.');
await mkdir(path.join(root, 'build'), { recursive: true });
await mkdir(path.join(root, 'dist/server'), { recursive: true });
await mkdir(path.join(root, 'dist/.openai'), { recursive: true });
await writeFile(path.join(root, 'build/assets.generated.mjs'), 'export const ASSETS = ' + JSON.stringify(assets) + ';\n');
await build({
  absWorkingDir: root,
  entryPoints: ['worker/index.js'],
  outfile: 'dist/server/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'inline',
  logLevel: 'warning',
});
await writeFile(path.join(root, 'dist/.openai/hosting.json'), JSON.stringify(hosting, null, 2) + '\n');
console.log('Built Worker with embedded public assets; runtime secrets are supplied at deployment.');

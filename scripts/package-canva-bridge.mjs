import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = new URL('../', import.meta.url);
const source = new URL('extensions/canva-bridge/', root);
const files = {};
for (const name of (await readdir(source)).sort()) {
  if (!/^[a-z0-9-]+\.(json|html|css|js)$/.test(name)) continue;
  files[`canva-bridge/${name}`] = new Uint8Array(await readFile(new URL(name, source)));
}
files['canva-bridge/LICENSE'] = new Uint8Array(await readFile(new URL('LICENSE', root)));
files['canva-bridge/README.md'] = new Uint8Array(await readFile(new URL('docs/CANVA-IMPORT.md', root)));
if (!files['canva-bridge/manifest.json']) throw new Error('The extension manifest is missing.');
const output = new URL('public/', root);
await mkdir(output, { recursive: true });
await writeFile(new URL('canva-bridge.zip', output), zipSync(files, { level: 6 }));
console.log(`Packaged extension: ${fileURLToPath(new URL('canva-bridge.zip', output))}`);

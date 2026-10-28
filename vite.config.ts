import { defineConfig } from 'vite';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  base: './', server: { port: 4480, strictPort: true }, build: { target: 'es2022' },
  plugins: [{ name: 'distribution-notices', apply: 'build', closeBundle() {
    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) copyFileSync(fileURLToPath(new URL(name, import.meta.url)), fileURLToPath(new URL(`dist/${name}`, import.meta.url)));
  } }],
});

import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadNativeInputs } from '../041-hp-codex-fidelity/src/local.ts';
import { LIVE_SUFFIX } from './src/live-scenarios.ts';

const root = fileURLToPath(new URL('./', import.meta.url));
await mkdir(`${root}/dist`, { recursive: true });
const result = await build({ entryPoints: [`${root}/src/browser-worker.ts`], outdir: `${root}/dist`,
  platform: 'browser', format: 'esm', target: 'es2024', bundle: true, metafile: true });
await writeFile(`${root}/dist/metafile.json`, JSON.stringify(result.metafile));
await copyFile(`${root}/index.html`, `${root}/dist/index.html`);
const native = await loadNativeInputs();
await writeFile(`${root}/dist/instructions.json`, JSON.stringify(native.instructions.text + LIVE_SUFFIX));
console.log(JSON.stringify({ built: true, inputs: Object.keys(result.metafile.inputs).length, noNodePlatform: true }));

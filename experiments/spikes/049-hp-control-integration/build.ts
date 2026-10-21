import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
const directory = new URL('./', import.meta.url).pathname;
await mkdir(`${directory}/dist`, { recursive: true });
await build({ entryPoints: [`${directory}/src/worker.ts`], outdir: `${directory}/dist`, platform: 'browser', format: 'esm', target: 'es2024', bundle: true });
await copyFile(`${directory}/index.html`, `${directory}/dist/index.html`);
console.log('Built identical control scenarios for a browser Worker');

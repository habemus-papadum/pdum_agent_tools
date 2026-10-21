import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = `${root}/dist`;
await mkdir(outdir, { recursive: true });
await build({ entryPoints: [`${root}/src/browser.ts`, `${root}/src/worker.ts`], outdir, bundle: true, format: 'esm', platform: 'browser', target: 'es2024', sourcemap: true });
await copyFile(`${root}/index.html`, `${outdir}/index.html`);
console.log(`Built browser UI and independent Worker into ${outdir}`);

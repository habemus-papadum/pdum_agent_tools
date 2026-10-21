import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const directory = new URL('../../../artifacts/043-hp-context-compaction/browser/', import.meta.url);
await mkdir(directory, { recursive: true });
const result = await build({
  entryPoints: [fileURLToPath(new URL('./compaction.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('compaction.js', directory)),
  bundle: true, platform: 'browser', format: 'esm', target: 'es2024', metafile: true,
});
console.log(JSON.stringify({ passed: true, inputs: Object.keys(result.metafile!.inputs), qualification: 'Browser bundle only; no browser provider call' }));

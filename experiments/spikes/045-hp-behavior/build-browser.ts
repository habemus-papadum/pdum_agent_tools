import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNativeInputs, loadPrompts } from '../041-hp-codex-fidelity/src/local.ts';
import { APPLICATION_SUFFIX } from './application.ts';

const directory = fileURLToPath(new URL('./', import.meta.url)); const outdir = resolve(directory, 'dist');
const { provenance: aiui } = await loadPrompts(); const native = await loadNativeInputs('gpt-6-luna');
const instructions = { ...native.instructions, text: native.instructions.text + APPLICATION_SUFFIX,
  origin: { component: 'hp-experiment-instructions', base: native.instructions.origin },
  spans: [{ start: 0, end: native.instructions.text.length, origin: native.instructions.origin },
    { start: native.instructions.text.length, end: native.instructions.text.length + APPLICATION_SUFFIX.length,
      origin: { component: 'host-environment-and-skill-catalog' } }] };
const alias = {
  '@habemus-papadum/aiui-prompts/operations': resolve(aiui.root, 'packages/aiui-prompts/src/operations.ts'),
  '@habemus-papadum/aiui-prompts/analysis': resolve(aiui.root, 'packages/aiui-prompts/src/analysis.ts'),
  '@habemus-papadum/aiui-prompts': resolve(aiui.root, 'packages/aiui-prompts/src/index.ts'),
  '@habemus-papadum/aiui-prompts-inspector/model': resolve(aiui.root, 'packages/aiui-prompts-inspector/src/model.ts'),
};
await mkdir(outdir, { recursive: true });
const built = await build({ entryPoints: [resolve(directory, 'browser-worker.ts'), resolve(directory, 'browser-ui.ts')],
  outdir, bundle: true, platform: 'browser', format: 'esm', target: 'es2024', sourcemap: true, alias,
  define: { __HP_NATIVE__: JSON.stringify({ instructions, codex: native.provenance, aiui, model: 'gpt-6-luna' }) }, metafile: true });
assert(Object.keys(built.metafile!.inputs).some((path) => path.includes('aiui-prompts-inspector/src/controller.ts')));
assert(Object.keys(built.metafile!.inputs).some((path) => path.includes('aiui-prompts/src/import.ts')));
await copyFile(resolve(directory, 'browser.html'), resolve(outdir, 'index.html'));
const provenance = { builtAt: new Date().toISOString(), aiui, codex: native.provenance, instructionUtf16: instructions.text.length,
  model: 'gpt-6-luna', effort: 'none', browserInputs: Object.keys(built.metafile!.inputs).length, providerRequests: 0,
  inspector: 'actual aiui-prompts-inspector/model; plain DOM presentation' };
await writeFile(resolve(outdir, 'build-provenance.json'), JSON.stringify(provenance, null, 2));
console.log(JSON.stringify({ outdir, ...provenance }, null, 2));

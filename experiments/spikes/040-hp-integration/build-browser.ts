import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadNativeInputs, loadPrompts } from '../041-hp-codex-fidelity/src/local.ts';

const directory = fileURLToPath(new URL('./', import.meta.url));
const outdir = resolve(directory, 'dist');
const { provenance: aiui } = await loadPrompts();
const native = await loadNativeInputs('gpt-6-luna');
const aliases = {
  '@habemus-papadum/aiui-prompts/operations': resolve(aiui.root, 'packages/aiui-prompts/src/operations.ts'),
  '@habemus-papadum/aiui-prompts/analysis': resolve(aiui.root, 'packages/aiui-prompts/src/analysis.ts'),
  '@habemus-papadum/aiui-prompts': resolve(aiui.root, 'packages/aiui-prompts/src/index.ts'),
  '@habemus-papadum/aiui-prompts-inspector/model': resolve(aiui.root, 'packages/aiui-prompts-inspector/src/model.ts'),
};
const define = { __HP_NATIVE__: JSON.stringify({ instructions: native.instructions, codex: native.provenance, aiui, model: 'gpt-6-luna' }) };
await mkdir(outdir, { recursive: true });
const built = await build({
  entryPoints: [resolve(directory, 'browser-worker.ts'), resolve(directory, 'browser-ui.ts')],
  outdir, bundle: true, platform: 'browser', format: 'esm', target: 'es2024', sourcemap: true,
  alias: aliases, define, metafile: true,
});
assert(Object.keys(built.metafile!.inputs).some((path) => path.includes('aiui-prompts-inspector/src/controller.ts')));
assert(Object.keys(built.metafile!.inputs).some((path) => path.includes('aiui-prompts/src/import.ts')));
await copyFile(resolve(directory, 'browser.html'), resolve(outdir, 'index.html'));
const manifest = { builtAt: new Date().toISOString(), aiui, codex: native.provenance,
  instructionUtf16: native.instructions.text.length, browserInputs: Object.keys(built.metafile!.inputs).length,
  inspector: 'actual aiui-prompts-inspector/model; plain DOM presentation', providerRequests: 0 };
await writeFile(resolve(outdir, 'build-provenance.json'), JSON.stringify(manifest, null, 2));

if (process.argv.includes('--test')) {
  const testfile = resolve(outdir, 'node-browser-smoke.mjs');
  await build({
    stdin: { resolveDir: directory, loader: 'ts', contents: `
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { createBrowserRuntime } from './browser-worker.ts';
import { PortClient, servePort } from '../039-hp-agent-runtime/src/protocol.ts';
import { runDemo } from '../039-hp-agent-runtime/src/demo.ts';
import { InspectorController, canonicalText } from '@habemus-papadum/aiui-prompts-inspector/model';
import { createFidelityAdapter } from '../041-hp-codex-fidelity/src/core.ts';
export async function run() {
  const instance = createBrowserRuntime();
  const ports = new MessageChannel(); const detach = servePort(instance.runtime,ports.port1); const client = new PortClient(ports.port2);
  let report;
  try { report=await runDemo(client); assert.equal(report.parentUnchanged,true); assert(instance.captures.length>0); }
  finally { client.close();detach();ports.port1.close();ports.port2.close();instance.close(); }
  const capture=instance.captures[0];
  const inspector=new InspectorController(capture.operation,{adapters:[createFidelityAdapter()]});
  assert.equal(inspector.error,null);assert.equal(canonicalText(inspector.compiled).length,18037);inspector.dispose();
  let sends=0;
  const scriptedFactory=async()=>({close(){},send(frame){sends++;assert.equal(frame.instructions.length,18037)},events:(async function*(){
    yield {type:'response.created',response:{id:'local-response'}};
    yield {type:'response.output_text.delta',item_id:'local-message',delta:'OFFLINE_SOCKET_OK'};
    yield {type:'response.output_item.done',item:{type:'message',id:'local-message',role:'assistant',content:[{type:'output_text',text:'OFFLINE_SOCKET_OK'}]}};
    yield {type:'response.completed',response:{id:'local-response',model:'gpt-6-luna'}};
  })()});
  const socket=createBrowserRuntime({live:true,factory:scriptedFactory});
  try {const thread=socket.runtime.create();socket.runtime.start(thread.id,'Offline boundary proof');const turn=await socket.runtime.wait(thread.id);assert.equal(turn.status,'completed');
    assert.equal(sends,1);assert.equal(socket.captures[0].verified,true);
    const sent=socket.captures[0];const inspector=new InspectorController(sent.wire,{operation:sent.operation,adapters:[createFidelityAdapter()]});
    assert.equal(inspector.error,null);assert.equal(inspector.document.verification.status,'equal');inspector.dispose();
  }finally{socket.close()}
  return {fixture:report,preparedCaptures:instance.captures.length,offlineSocketSends:sends,socketReplayVerified:true,headlessInspector:true,providerRequests:0};
}` },
    outfile: testfile, bundle: true, platform: 'node', format: 'esm', target: 'node26', alias: aliases, define,
  });
  const test = await import(pathToFileURL(testfile).href) as { run(): Promise<unknown> };
  const result = await test.run();
  await writeFile(resolve(outdir, 'node-browser-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({ outdir, ...manifest }, null, 2));

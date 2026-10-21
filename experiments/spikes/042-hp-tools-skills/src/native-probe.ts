/** Existing native binary only, isolated HOME/CODEX_HOME, zero model requests. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyPatch, nativeApplyPatchGrammar } from './patch.ts';
import { patchCorpus } from './patch-corpus.ts';
import { ExecSessions } from './exec.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const binary = resolve(process.env.HP_CODEX_BINARY ?? join(root, 'artifacts/003-codex-control/target/debug/codex'));
const revision = execFileSync('git', ['-C', join(root, 'vendor/codex'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(revision, '6c372fbef45f730b6d8aa727b0ec8332365588db');
assert.equal(nativeApplyPatchGrammar, await readFile(join(root, 'vendor/codex/codex-rs/core/assets/tools/apply_patch.lark'), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'hp-native-tools-'));
const home = join(temporary, 'home'); await mkdir(home);
const environment = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, LANG: 'en_US.UTF-8' };
const results: Record<string, unknown> = { date: new Date().toISOString(), node: process.version, binary,
  version: execFileSync(binary, ['--version'], { encoding: 'utf8', env: environment }).trim(), revision, providerRequests: 0, estimatedUsd: 0 };
async function tree(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await tree(directory, path));
    else result[path] = await readFile(join(directory, path), 'utf8');
  }
  return result;
}
try {
  const patches = [];
  for (const [index, example] of patchCorpus.entries()) {
    const hpRoot = join(temporary, `hp-${index}`); const nativeRoot = join(temporary, `native-${index}`);
    for (const cwd of [hpRoot, nativeRoot]) {
      await mkdir(cwd);
      for (const [path, text] of Object.entries(example.files)) { await mkdir(join(cwd, path, '..'), { recursive: true }); await writeFile(join(cwd, path), text); }
    }
    let hpSucceeded = false; let hpOutput = '';
    try { hpOutput = (await applyPatch(example.patch, hpRoot)).output; hpSucceeded = true; }
    catch (error) { hpOutput = String(error); }
    const native = spawnSync(binary, ['--codex-run-as-apply-patch', example.patch], { cwd: nativeRoot, env: environment, encoding: 'utf8', timeout: 10000 });
    if (native.error) throw native.error;
    const hpFiles = await tree(hpRoot); const nativeFiles = await tree(nativeRoot);
    const sameFiles = JSON.stringify(Object.entries(hpFiles).sort()) === JSON.stringify(Object.entries(nativeFiles).sort());
    patches.push({ name: example.name, hpSucceeded, nativeSucceeded: native.status === 0, sameFiles,
      equivalent: sameFiles && hpSucceeded === (native.status === 0), hpOutput, nativeStdout: native.stdout, nativeStderr: native.stderr,
      ...(!sameFiles ? { hpFiles, nativeFiles } : {}) });
  }
  results.patches = patches; results.patchMatches = patches.filter((entry) => entry.equivalent).length;
  // This compares native command/exec pipes with HP exec_command pipes. It does
  // not claim that app-server command/exec is the model's unified-exec handler.
  const { Rpc } = await import(pathToFileURL(join(root, 'spikes/030-codex-remote-operations/rpc.mjs')).href);
  const cwd = join(temporary, 'commands'); await mkdir(cwd);
  const rpc = Rpc.stdio(binary, home, cwd); const exited = once(rpc.child, 'exit');
  const hp = new ExecSessions(cwd);
  try {
    await rpc.initialize();
    const command = 'printf "OUT 🧪"; printf "ERR" >&2; exit 7';
    const native = await rpc.request('command/exec', { command: ['/bin/sh', '-c', command], cwd, timeoutMs: 3000, disableOutputCap: true });
    const own = await hp.exec({ cmd: command, shell: '/bin/sh', login: false }, new AbortController().signal);
    assert.equal(native.exitCode, own.exit_code); assert(own.output.includes(native.stdout) && own.output.includes(native.stderr));
    const interactive = rpc.request('command/exec', { command: ['/bin/sh', '-c', 'printf READY; read x; printf "GOT:%s" "$x"'], cwd, processId: 'native-input', streamStdin: true, streamStdoutStderr: true, timeoutMs: 3000, disableOutputCap: true });
    await rpc.wait((event: { method: string; params?: { processId?: string } }) => event.method === 'command/exec/outputDelta' && event.params?.processId === 'native-input');
    await rpc.request('command/exec/write', { processId: 'native-input', deltaBase64: Buffer.from('input\n').toString('base64') });
    const nativeInteractive = await interactive;
    const deltas = rpc.events.filter((event: { method: string; params?: { processId?: string } }) => event.method === 'command/exec/outputDelta' && event.params?.processId === 'native-input');
    const nativeOutput = deltas.map((event: { params: { deltaBase64: string } }) => Buffer.from(event.params.deltaBase64, 'base64').toString()).join('');
    const ownStart = await hp.exec({ cmd: 'printf READY; read x; printf "GOT:%s" "$x"', shell: '/bin/sh', login: false, yield_time_ms: 250 }, new AbortController().signal);
    const ownEnd = await hp.write({ session_id: ownStart.session_id!, chars: 'input\n', yield_time_ms: 1000 }, new AbortController().signal);
    assert.equal(nativeInteractive.exitCode, ownEnd.exit_code); assert.equal(nativeOutput, ownStart.output + ownEnd.output);
    results.commands = { buffered: { native, hp: own, exitAndContentMatch: true }, interactive: { native: nativeInteractive, output: nativeOutput, hp: [ownStart, ownEnd], exitAndContentMatch: true }, boundary: 'Native app-server command/exec, not model unified-exec direct invocation' };
  } finally {
    await hp.close(); rpc.close(); const kill = setTimeout(() => rpc.child.kill('SIGKILL'), 2000);
    await exited; clearTimeout(kill);
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
const artifacts = join(root, 'artifacts/042-hp-tools-skills'); await mkdir(artifacts, { recursive: true });
await writeFile(join(artifacts, 'native-summary.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));

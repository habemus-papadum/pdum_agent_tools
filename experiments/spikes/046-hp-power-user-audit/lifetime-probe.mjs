/** Zero-model probe: compare HP pipes with installed native app-server pipes.
 * Native command/exec is deliberately not called a unified-exec tool oracle.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecSessions } from '../042-hp-tools-skills/src/exec.ts';
import { Rpc } from '../030-codex-remote-operations/rpc.mjs';

const artifacts = fileURLToPath(new URL('../../artifacts/046-hp-power-user-audit/', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'hp-power-lifetime-'));
const home = join(temporary, 'home'); const cwd = join(temporary, 'work');
await mkdir(home); await mkdir(cwd);
const environment = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, LANG: 'en_US.UTF-8' };
const binary = process.env.HP_AUDIT_CODEX_BINARY ?? execFileSync('/usr/bin/which', ['codex'], { env: environment, encoding: 'utf8' }).trim();
const report = { date: new Date().toISOString(), node: process.version,
  native: { binary, version: execFileSync(binary, ['--version'], { env: environment, encoding: 'utf8' }).trim(), layer: 'app-server command/exec; NOT the model unified-exec handler' },
  referencePin: '6c372fbef45f730b6d8aa727b0ec8332365588db', modelRequests: 0, estimatedUsd: 0 };
const command = "trap 'echo INT-TRAP; exit 42' INT; echo READY; while true; do sleep 30; done";
const signal = new AbortController(); const hp = new ExecSessions(cwd);
const rpc = Rpc.stdio(binary, home, cwd); const exited = once(rpc.child, 'exit');
try {
  const first = await hp.exec({ cmd: command, shell: '/bin/sh', login: false, yield_time_ms: 250 }, signal.signal);
  assert(first.session_id && first.output.includes('READY'));
  const written = await hp.write({ session_id: first.session_id, chars: '\u0003', yield_time_ms: 250 }, new AbortController().signal);
  report.hp = { first, afterControlC: written, controlCInterpretedAsSignal: written.exit_code === 42 || written.exit_code === 130 || written.termination_signal === 'SIGINT',
    sourceInspectedLifetimePolicy: 'Originating turn abort terminates the yielded process group; differs from native unified background sessions.' };
  signal.abort(new Error('credential-free probe cleanup'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  report.hp.sessionsAfterOriginatingAbortBeforeClose = hp.sessions();
  await hp.close();
  report.hp.sessionsAfterTurnAbortAndClose = hp.sessions().length;

  await rpc.initialize();
  let done = false;
  const running = rpc.request('command/exec', { command: ['/bin/sh', '-c', command], cwd,
    processId: 'ctrl-c-layer-probe', streamStdin: true, streamStdoutStderr: true, timeoutMs: 3000, disableOutputCap: true }, 5000);
  void running.then(() => { done = true; }, () => { done = true; });
  await rpc.wait((event) => event.method === 'command/exec/outputDelta' && event.params?.processId === 'ctrl-c-layer-probe');
  await rpc.request('command/exec/write', { processId: 'ctrl-c-layer-probe', deltaBase64: Buffer.from('\u0003').toString('base64') });
  await new Promise((resolve) => setTimeout(resolve, 250));
  report.native.controlCFinishedWithin250ms = done;
  if (!done) { await rpc.request('command/exec/terminate', { processId: 'ctrl-c-layer-probe' }); report.native.explicitTerminationRequired = true; }
  report.native.result = await running;
  report.native.output = rpc.events.filter((event) => event.method === 'command/exec/outputDelta' && event.params?.processId === 'ctrl-c-layer-probe')
    .map((event) => Buffer.from(event.params.deltaBase64, 'base64').toString()).join('');
  report.interpretation = 'Live native app-server pipe behavior and local HP behavior are recorded separately. Pinned unified-exec tool tests define Ctrl-C and turn-interrupt semantics at a higher layer; this probe does not execute those Rust tests.';
} finally {
  await hp.close(); rpc.close(); const kill = setTimeout(() => rpc.child.kill('SIGKILL'), 2000);
  await exited; clearTimeout(kill); await rm(temporary, { recursive: true, force: true });
}
await mkdir(artifacts, { recursive: true });
await writeFile(join(artifacts, 'lifetime-probe.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

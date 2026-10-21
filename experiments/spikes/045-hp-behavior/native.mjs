import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, constants } from 'node:fs';
import { readFile, writeFile, mkdir, access, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--run-dir', 'Usage: native.mjs --run-dir PREPARED_RUN_DIRECTORY');
assert(process.env.OPENAI_API_KEY, 'Host API key required');
const directory = resolve(args[1]);
const manifest = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
assert(manifest.agent === 'codex' && manifest.config.model === 'gpt-6-luna');
assert(!manifest.started_at, 'Use a fresh prepared run');
// Read everything needed for launch before creating a profile or starting a child.
const prompt = await readFile(join(directory, 'prompt.txt'), 'utf8');
const root = fileURLToPath(new URL('../../', import.meta.url));
const binary = resolve(process.env.HP_CODEX_BINARY ?? join(root, 'artifacts/003-codex-control/target/debug/codex'));
const resolvedBinary = await realpath(binary);
const codeModeHost = join(dirname(resolvedBinary), 'codex-code-mode-host');
await access(codeModeHost, constants.X_OK);
manifest.binary = { path: binary, version: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim() };
manifest.binary.sha256 = createHash('sha256').update(await readFile(resolvedBinary)).digest('hex');
manifest.code_mode_host = { path: codeModeHost, sha256: createHash('sha256').update(await readFile(codeModeHost)).digest('hex') };
const profile = join(directory, 'profile');
await mkdir(profile);
const overrides = ['model_reasoning_effort="low"', 'service_tier="default"', 'approval_policy="never"',
  'analytics.enabled=false', 'feedback.enabled=false', 'features.apps=false', 'features.plugins=false',
  'skills.bundled.enabled=false', 'features.multi_agent=false', 'web_search="disabled"'];
const command = ['exec', '--json', '--model', 'gpt-6-luna', '--sandbox', 'danger-full-access',
  '--skip-git-repo-check', '--ignore-user-config', '--color', 'never', '-o', join(directory, 'answer.txt'),
  ...overrides.flatMap(x => ['-c', x]), '-'];
manifest.started_at = new Date().toISOString(); manifest.profile = profile;
manifest.execution = 'one native Codex exec task; isolated home; wall limit 180s; no harness retries';
await writeFile(join(directory, 'run.json'), JSON.stringify(manifest, null, 2));

const start = performance.now();
let child;
let closed;
let groupId;
let termination;
let timer;
let timedOut = false;
let failure;
let receivedSignal;
let result = { code: null, signal: null };
const captures = [];
const sinks = [];
const recordFailure = (error) => { failure ??= error instanceof Error ? error.message : String(error); };

// The detached group is ours even after its leader closes. Retire its identity as
// soon as disappearance is observed; never cancel escalation on leader exit alone.
function groupExists() {
  if (!groupId) return false;
  try { process.kill(-groupId, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') { groupId = undefined; return false; } throw error; }
}
function signalGroup(signal) {
  if (!groupId) return;
  try { process.kill(-groupId, signal); }
  catch (error) { if (error.code === 'ESRCH') groupId = undefined; else throw error; }
}
function terminateOwnedGroup() {
  if (termination) return termination;
  termination = (async () => {
    if (!groupExists()) return;
    signalGroup('SIGTERM');
    const deadline = performance.now() + 2000;
    while (groupExists() && performance.now() < deadline) await delay(20);
    if (groupExists()) signalGroup('SIGKILL');
  })().catch(recordFailure);
  return termination;
}
function stop(error) {
  recordFailure(error);
  // Close parent pipe handles after terminating the owned group. A descendant
  // retaining a pipe must not keep a failed harness waiting forever for close.
  void terminateOwnedGroup().finally(() => {
    child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
  });
}
const onInterrupt = () => { receivedSignal = 'SIGINT'; stop(new Error('Native harness interrupted by SIGINT')); };
const onTerminate = () => { receivedSignal = 'SIGTERM'; stop(new Error('Native harness interrupted by SIGTERM')); };
try {
  child = spawn(binary, command, { cwd: manifest.worktree, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: profile, CODEX_HOME: profile, CODEX_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY, LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR ?? '/tmp' } });
  groupId = child.pid;
  manifest.native_pid = child.pid ?? null;
  closed = new Promise((resolve) => {
    child.once('error', stop);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  child.stdin.on('error', stop);
  let lineBuffer = '';
  child.stdout.on('data', chunk => {
    lineBuffer += chunk.toString();
    for (;;) {
      const newline = lineBuffer.indexOf('\n'); if (newline < 0) break;
      const line = lineBuffer.slice(0, newline); lineBuffer = lineBuffer.slice(newline + 1);
      try { const event = JSON.parse(line); if (event.type === 'thread.started') manifest.root_thread_id = event.thread_id; }
      catch { /* Original bytes remain in the raw file. */ }
    }
  });
  const out = createWriteStream(join(directory, 'events.jsonl'));
  const err = createWriteStream(join(directory, 'stderr.log'));
  sinks.push(out, err);
  // Attach error handlers immediately. Await these pipelines so completion also
  // means buffered capture bytes were flushed, or their failure was recorded.
  captures.push(pipeline(child.stdout, out).catch(stop), pipeline(child.stderr, err).catch(stop));
  timer = setTimeout(() => { timedOut = true; stop(new Error('Native experiment wall-time bound exceeded')); }, 180000);
  child.stdin.end(prompt);
  result = await closed;
  await Promise.all(captures);
} catch (error) { stop(error); }
finally {
  clearTimeout(timer);
  await terminateOwnedGroup();
  if (failure) { child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy(); }
  if (closed) result = await closed;
  await Promise.all(captures);
  for (const sink of sinks) if (!sink.closed) sink.destroy();
  process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
  manifest.seconds = (performance.now() - start) / 1000;
  manifest.completed_at = new Date().toISOString();
  manifest.exit_code = receivedSignal === 'SIGINT' ? 130 : receivedSignal === 'SIGTERM' ? 143 : failure ? 1 : result.code ?? 1;
  manifest.timed_out = timedOut;
  manifest.termination_signal = result.signal;
  if (failure) manifest.failure = failure;
  try { await writeFile(join(directory, 'run.json'), JSON.stringify(manifest, null, 2)); }
  catch (error) { recordFailure(error); manifest.exit_code = 1; }
  console.log(JSON.stringify({ runId: manifest.run_id, ...result, timedOut, failure: failure ?? null,
    seconds: manifest.seconds, directory }, null, 2));
  process.exitCode = manifest.exit_code;
}

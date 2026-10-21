import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const harness = fileURLToPath(new URL('./native.mjs', import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const exists = async (path) => access(path).then(() => true, () => false);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function eventually(predicate, message) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) { if (await predicate()) return; await delay(20); }
  assert.fail(message);
}
async function fixture({ prompt = true, body = 'cat >/dev/null\nprintf \'{"type":"thread.started","thread_id":"thread-fixture"}\\n\'\nprintf "fixture stderr\\n" >&2\nexit 0\n' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hp-native-cleanup-'));
  const bin = join(root, 'bin'), directory = join(root, 'run'), work = join(root, 'work');
  await Promise.all([mkdir(bin), mkdir(directory), mkdir(work)]);
  const binary = join(bin, 'codex');
  const marker = join(root, 'spawned.pid');
  const descendant = join(root, 'descendant.pid');
  const script = '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-review-fixture"; exit 0; fi\n'
    + `echo $$ > ${quote(marker)}\n` + body.replaceAll('DESCENDANT_PATH', quote(descendant)).replaceAll('READY_PATH', quote(join(root, 'ready')));
  await writeFile(binary, script); await chmod(binary, 0o755);
  const host = join(bin, 'codex-code-mode-host');
  await writeFile(host, '#!/bin/sh\nexit 0\n'); await chmod(host, 0o755);
  const manifest = { agent: 'codex', run_id: 'native-cleanup-fixture', config: { model: 'gpt-6-luna' }, worktree: work };
  await writeFile(join(directory, 'run.json'), JSON.stringify(manifest));
  if (prompt) await writeFile(join(directory, 'prompt.txt'), 'A local fixture only.');
  let child;
  let completion;
  const start = () => {
    assert(!child);
    child = spawn(process.execPath, [harness, '--run-dir', directory], {
      // This fixture never contacts a provider or inherits a real key.
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, OPENAI_API_KEY: 'local-fixture-no-provider', HP_CODEX_BINARY: binary },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return completion;
  };
  return { root, directory, marker, descendant, manifest, start,
    signal(signal) { child.kill(signal); },
    async readManifest() { return JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')); },
    async close() {
      if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL');
      if (completion) await completion;
      if (await exists(marker)) {
        const pid = Number((await readFile(marker, 'utf8')).trim());
        try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('missing prompt is a preflight failure: no process/profile or started manifest', { timeout: 10000 }, async () => {
  const env = await fixture({ prompt: false });
  try {
    const result = await env.start();
    assert.equal(result.code, 1); assert.match(result.stderr, /prompt\.txt/);
    assert.equal(await exists(env.marker), false);
    assert.equal(await exists(join(env.directory, 'profile')), false);
    assert.deepEqual(await env.readManifest(), env.manifest);
  } finally { await env.close(); }
});

test('capture error after launch cleans owned group and finalizes the failed run', { timeout: 10000 }, async () => {
  const env = await fixture({ body: 'cat >/dev/null\nsleep 60\n' });
  try {
    await mkdir(join(env.directory, 'events.jsonl'));
    const result = await env.start();
    assert.equal(result.code, 1);
    const manifest = await env.readManifest();
    assert.ok(manifest.native_pid > 0, 'The child was launched before the injected file-open failure');
    assert.equal(manifest.exit_code, 1); assert.ok(manifest.completed_at);
    assert.match(manifest.failure, /EISDIR/);
    await eventually(() => !alive(manifest.native_pid), 'Failed native child survived capture failure');
  } finally { await env.close(); }
});

test('successful capture is flushed and TERM-ignoring descendants are cleaned after leader exit', { timeout: 10000 }, async () => {
  const env = await fixture({ body: 'cat >/dev/null\nsh -c \'trap "" TERM; echo READY; exec sleep 60\' </dev/null > READY_PATH 2>/dev/null &\necho $! > DESCENDANT_PATH\nwhile [ ! -s READY_PATH ]; do sleep 0.02; done\nprintf \'{"type":"thread.started","thread_id":"thread-fixture"}\\n\'\nprintf "fixture stderr\\n" >&2\nexit 0\n' });
  try {
    const result = await env.start();
    assert.equal(result.code, 0, result.stderr);
    const manifest = await env.readManifest();
    assert.equal(manifest.exit_code, 0); assert.equal(manifest.root_thread_id, 'thread-fixture');
    assert.equal(manifest.timed_out, false); assert.ok(manifest.completed_at);
    assert(manifest.seconds >= 1.8, 'TERM-ignoring descendant must reach the SIGKILL escalation');
    assert.deepEqual(JSON.parse((await readFile(join(env.directory, 'events.jsonl'), 'utf8')).trim()), { type: 'thread.started', thread_id: 'thread-fixture' });
    assert.equal(await readFile(join(env.directory, 'stderr.log'), 'utf8'), 'fixture stderr\n');
    const descendant = Number((await readFile(env.descendant, 'utf8')).trim());
    await eventually(() => !alive(descendant), 'Owned descendant survived leader exit cleanup');
  } finally { await env.close(); }
});

test('SIGTERM is propagated to owned processes and records completed interruption state', { timeout: 10000 }, async () => {
  const env = await fixture({ body: 'cat >/dev/null\nsleep 60\n' });
  try {
    const completion = env.start();
    await eventually(() => exists(env.marker), 'Native fixture did not start');
    env.signal('SIGTERM');
    const result = await completion;
    assert.equal(result.code, 143, result.stderr);
    const manifest = await env.readManifest();
    assert.equal(manifest.exit_code, 143); assert.ok(manifest.completed_at);
    assert.match(manifest.failure, /SIGTERM/);
    await eventually(() => !alive(manifest.native_pid), 'Native child survived harness interruption');
  } finally { await env.close(); }
});

import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ExecSessions } from './exec.ts';
import { applyPatch, PatchFailure } from './patch.ts';
import { patchCorpus } from './patch-corpus.ts';
import { createNodeTools, createSkillContext } from './index.ts';
import { connectHttpMcp, createMcpTools, McpToolFailure } from './mcp.ts';
import { startLocalMcpServer } from './local-mcp.ts';
import type { Tool } from '../../039-hp-agent-runtime/src/runtime.ts';
import { JobRegistry } from '../../039-hp-agent-runtime/src/jobs/registry.ts';

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
export async function fileTree(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await fileTree(root, path));
    else result[path] = await readFile(join(root, path), 'utf8');
  }
  return result;
}
export async function initializeFiles(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); }
}

test('real shell exit, stderr, cwd, Unicode and startup failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hp-tools-'));
  const exec = new ExecSessions(root); const signal = new AbortController().signal;
  try {
    const result = await exec.exec({ cmd: 'printf "hello 🧪"; printf " error" >&2; exit 7', login: false }, signal);
    assert.equal(result.exit_code, 7); assert.match(result.output, /hello 🧪/); assert.match(result.output, /error/);
    assert.equal((await exec.exec({ cmd: 'pwd', login: false }, signal)).output.trim(), await realpath(root));
    await assert.rejects(exec.exec({ cmd: 'true', shell: '/no-such-hp-shell' }, signal), /ENOENT/);
    await assert.rejects(exec.exec({ cmd: 'true', tty: true }, signal), /PTY/);
  } finally { await exec.close(); await rm(root, { recursive: true, force: true }); }
});

test('yielded session accepts stdin and incremental output is not duplicated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hp-session-')); const exec = new ExecSessions(root);
  const signal = new AbortController().signal;
  try {
    const source = 'process.stdout.write("READY\\n"); process.stdin.once("data",b=>{process.stdout.write("GOT:"+b);process.exit(0)})';
    const first = await exec.exec({ cmd: `${quote(process.execPath)} -e ${quote(source)}`, login: false, yield_time_ms: 250 }, signal);
    assert.equal(typeof first.session_id, 'number'); assert.equal(first.output, 'READY\n');
    const second = await exec.write({ session_id: first.session_id!, chars: 'input 🧪\n', yield_time_ms: 1000 }, signal);
    assert.equal(second.exit_code, 0); assert.equal(second.output, 'GOT:input 🧪\n');
    await assert.rejects(exec.write({ session_id: first.session_id! }, signal), /Unknown/);
  } finally { await exec.close(); await rm(root, { recursive: true, force: true }); }
});

test('original turn interruption preserves a yielded process; explicit termination kills it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hp-cancel-')); const exec = new ExecSessions(root); const controller = new AbortController();
  try {
    const first = await exec.exec({ cmd: 'sleep 60 & wait', login: false, yield_time_ms: 250 }, controller.signal);
    const pid = exec.sessions()[0]!.pid!; assert.equal(typeof first.session_id, 'number');
    controller.abort(new Error('probe cancelled'));
    await assert.rejects(exec.write({ session_id: first.session_id!, yield_time_ms: 100 }, controller.signal), /probe cancelled/);
    process.kill(pid, 0); assert.equal(exec.sessions()[0]!.running, true);
    const result = await exec.terminate(first.session_id!); assert.ok(result.termination_signal);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.equal(exec.sessions().length, 0);
  } finally { await exec.close(); await rm(root, { recursive: true, force: true }); }
});

test('cancelling a backpressured stdin wait preserves the process and cannot retract accepted bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hp-backpressure-')); const exec = new ExecSessions(root);
  const controller = new AbortController();
  try {
    const first = await exec.exec({ cmd: 'sleep 60', login: false, yield_time_ms: 250 }, new AbortController().signal);
    const writing = exec.write({ session_id: first.session_id!, chars: 'x'.repeat(1024 * 1024) }, controller.signal);
    const timer = setTimeout(() => controller.abort(new Error('stdin probe cancelled')), 50);
    await assert.rejects(writing, /stdin probe cancelled/); clearTimeout(timer);
    assert.equal(exec.sessions()[0]!.running, true); process.kill(exec.sessions()[0]!.pid!, 0);
  } finally { await exec.close(); await rm(root, { recursive: true, force: true }); }
});

test('interrupted first collection preserves undisclosed session and its output for later discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hp-initial-wait-')); const exec = new ExecSessions(root); const controller = new AbortController();
  try {
    const running = exec.exec({ cmd: 'printf READY; sleep 60', login: false, yield_time_ms: 10000 }, controller.signal);
    const timer = setTimeout(() => controller.abort(new Error('initial wait interrupted')), 50);
    await assert.rejects(running, /initial wait interrupted/); clearTimeout(timer);
    const session = exec.sessions()[0]!; assert.equal(session.running, true); process.kill(session.pid!, 0);
    const output = await exec.write({ session_id: session.session_id, yield_time_ms: 0 }, new AbortController().signal);
    assert.equal(output.output, 'READY'); await exec.terminate(session.session_id);
  } finally { await exec.close(); await rm(root, { recursive: true, force: true }); }
});

test('cancelling a pending poll leaves output intact for a subsequent collector', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hp-poll-wait-')); const exec = new ExecSessions(root);
  const signal = new AbortController().signal; const controller = new AbortController();
  try {
    const first = await exec.exec({ cmd: 'printf FIRST; sleep 0.5; printf LATER; sleep 60', login: false, yield_time_ms: 250 }, signal);
    assert.equal(first.output, 'FIRST');
    const poll = exec.write({ session_id: first.session_id!, yield_time_ms: 10000 }, controller.signal);
    const timer = setTimeout(() => controller.abort(new Error('poll abandoned')), 400);
    await assert.rejects(poll, /poll abandoned/); clearTimeout(timer);
    const next = await exec.write({ session_id: first.session_id!, yield_time_ms: 0 }, signal);
    assert.equal(next.output, 'LATER'); await exec.terminate(first.session_id!);
  } finally { await exec.close(); await rm(root, { recursive: true, force: true }); }
});

test('registry cancellation owns only its shell job and final output drains before settlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hp-shell-jobs-')); const jobs = new JobRegistry();
  const a = new ExecSessions(root, { jobs, ownerId: 'a' }); const b = new ExecSessions(root, { jobs, ownerId: 'b' });
  const signal = new AbortController().signal;
  try {
    const source = 'process.stdout.write("READY\\n");process.on("SIGTERM",()=>process.stdout.write("FINAL\\n",()=>process.exit(0)));setInterval(()=>{},1000)';
    const first = await a.exec({ cmd: `exec ${quote(process.execPath)} -e ${quote(source)}`, login: false, yield_time_ms: 250 }, signal, { threadId: 'thread', turnId: 'turn' });
    const other = await b.exec({ cmd: 'sleep 60', login: false, yield_time_ms: 250 }, signal);
    assert.equal(first.output, 'READY\n'); const info = a.sessions()[0]!;
    jobs.closeOwner('a'); const settled = await jobs.wait(info.job_id);
    assert.equal(settled.job.status, 'cancelled'); assert.equal(settled.job.threadId, 'thread'); assert.equal(settled.job.turnId, 'turn');
    const final = await a.write({ session_id: first.session_id!, yield_time_ms: 0 }, signal);
    assert.equal(final.output, 'FINAL\n'); assert.equal(final.exit_code, 0);
    assert.ok(jobs.events({ jobId: info.job_id }).some(event => event.kind === 'output' && (event.data.value as { text: string }).text === 'FINAL\n'));
    assert.equal(b.sessions()[0]!.running, true); await b.terminate(other.session_id!);
  } finally { await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test('closing immediately after admission prevents a not-yet-started shell job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hp-shell-close-')); const exec = new ExecSessions(root);
  try {
    const running = exec.exec({ cmd: 'sleep 60', login: false }, new AbortController().signal);
    const failure = assert.rejects(running, /closed/); await exec.close(); await failure;
    assert.equal(exec.sessions().length, 0); assert.equal(exec.jobs.list()[0]!.status, 'cancelled');
  } finally { await exec.close(); await rm(root, { recursive: true, force: true }); }
});

test('cleanup escalates for a TERM-ignoring descendant after its leader closes stdio', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX process-group comparison'); return; }
  const root = await mkdtemp(join(tmpdir(), 'hp-descendant-')); const exec = new ExecSessions(root);
  const controller = new AbortController();
  try {
    const first = await exec.exec({ cmd: `sh -c 'trap "" TERM; exec sleep 60' </dev/null >/dev/null 2>&1 & echo $!; wait`, shell: '/bin/sh', login: false, yield_time_ms: 250 }, controller.signal);
    const descendant = Number(first.output.trim()); assert.ok(descendant > 1); process.kill(descendant, 0);
    controller.abort(new Error('descendant probe cancelled')); await exec.close();
    let alive = true;
    for (let i = 0; i < 20; i++) {
      try { process.kill(descendant, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { alive = false; break; } throw error; }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(alive, false, 'owned descendant must not survive tools.close()');
  } finally { await exec.close(); await rm(root, { recursive: true, force: true }); }
});

for (const example of patchCorpus) test(`patch corpus: ${example.name}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hp-patch-'));
  try {
    await initializeFiles(root, example.files);
    if (example.succeeds) await applyPatch(example.patch, root);
    else await assert.rejects(applyPatch(example.patch, root));
    assert.deepEqual(await fileTree(root), example.expected);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed move reports an already-written destination when source unlink is denied', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('requires POSIX user permission denial'); return; }
  const root = await mkdtemp(join(tmpdir(), 'hp-partial-move-')); const locked = join(root, 'locked');
  try {
    await initializeFiles(root, { 'locked/old.txt': 'old\n', 'new.txt': 'overwritten\n' }); await chmod(locked, 0o555);
    let failure: PatchFailure | undefined;
    try { await applyPatch('*** Begin Patch\n*** Update File: locked/old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** End Patch', root); }
    catch (error) { assert.ok(error instanceof PatchFailure); failure = error; }
    assert.ok(failure); assert.equal(await readFile(join(locked, 'old.txt'), 'utf8'), 'old\n');
    assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'new\n');
    assert.deepEqual(failure.applied, [{ kind: 'add', path: 'new.txt', before: 'overwritten\n', after: 'new\n', partial_move_from: 'locked/old.txt', source_removed: false }]);
  } finally { await chmod(locked, 0o755); await rm(root, { recursive: true, force: true }); }
});

test('Node Tool[] fixes a real failing node --test task in a scratch workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hp-task-')); const tools = createNodeTools({ cwd: root });
  const context = { signal: new AbortController().signal } as Parameters<Tool['execute']>[1];
  const invoke = (name: string, text: string) => tools.find((tool) => tool.definition.name === name)!.execute(text, context);
  try {
    await writeFile(join(root, 'sum.cjs'), 'module.exports=(a,b)=>a-b;\n');
    await writeFile(join(root, 'sum.test.cjs'), "const assert=require('node:assert/strict');require('node:test')('sum',()=>assert.equal(require('./sum.cjs')(2,3),5));\n");
    // The outer node:test runner sets an internal child protocol variable. This
    // standalone nested test invocation must not inherit that runner protocol.
    const command = JSON.stringify({ cmd: `env -u NODE_TEST_CONTEXT ${quote(process.execPath)} --test sum.test.cjs`, login: false });
    assert.notEqual(JSON.parse(await invoke('exec_command', command)).exit_code, 0);
    await invoke('apply_patch', '*** Begin Patch\n*** Update File: sum.cjs\n@@\n-module.exports=(a,b)=>a-b;\n+module.exports=(a,b)=>a+b;\n*** End Patch');
    assert.equal(JSON.parse(await invoke('exec_command', command)).exit_code, 0);
  } finally { await tools.close(); await rm(root, { recursive: true, force: true }); }
});

test('explicit skill catalog/load records exact source and detects ambiguity/changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hp-skills-'));
  try {
    const text = '---\nname: accounting\ndescription: >-\n  Inspect usage\n  before estimating cost.\n---\n\nExact skill 🧪 text.\n';
    await initializeFiles(root, { 'one/SKILL.md': text });
    const skills = await createSkillContext({ roots: [root], revision: 'fixture-revision' });
    assert.match(skills.renderCatalog(), /accounting: Inspect usage before estimating cost/);
    const loaded = await skills.load('accounting'); assert.equal(loaded.text, text); assert.equal(loaded.origin.revision, 'fixture-revision');
    await writeFile(join(root, 'one/SKILL.md'), text + 'Updated.\n');
    assert.notEqual((await skills.load('accounting')).origin.sha256, loaded.origin.sha256);
    await initializeFiles(root, { 'two/SKILL.md': text });
    const duplicate = await createSkillContext({ roots: [root] });
    await assert.rejects(duplicate.load('accounting'), /Ambiguous/);
    assert.equal((await duplicate.load(join(root, 'two/SKILL.md'))).text, text);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('official MCP client performs real local HTTP initialization, tool call, error and cancellation', async () => {
  const server = await startLocalMcpServer(); const connection = await connectHttpMcp(server.url);
  const context = { signal: new AbortController().signal } as Parameters<Tool['execute']>[1];
  try {
    const tools = await createMcpTools(connection.client, { serverName: 'local' });
    const result = JSON.parse(await tools.find((tool) => tool.definition.name === 'mcp__local__echo')!.execute('{"text":"MCP 🧪"}', context));
    assert.equal(result.content[0].text, 'MCP 🧪'); assert.equal(result.content[1].resource.text, 'MCP 🧪');
    assert.equal(result.structuredContent.source, 'local-mcp-server');
    await assert.rejects(tools.find((tool) => tool.definition.name === 'mcp__local__fail')!.execute('{}', context), McpToolFailure);
    const cancelled = new AbortController();
    const waiting = tools.find((tool) => tool.definition.name === 'mcp__local__wait')!.execute('{}', { ...context, signal: cancelled.signal });
    const timer = setTimeout(() => cancelled.abort(new Error('MCP probe cancelled')), 100);
    await assert.rejects(waiting); clearTimeout(timer);
    assert.ok(server.requests() >= 4); assert.deepEqual(server.calls.map((call) => call.name), ['echo', 'fail', 'wait']);
  } finally { await connection.close(); await server.close(); }
});

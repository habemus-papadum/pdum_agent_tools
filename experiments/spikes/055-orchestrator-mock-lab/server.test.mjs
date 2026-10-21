import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function launch(extraEnv = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url))], {
    env: { ...process.env, PORT: '0', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let errors = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { errors += text; });
  const lines = createInterface({ input: child.stdout });
  try {
    const ready = await Promise.race([
      new Promise((resolve, reject) => lines.once('line', line => { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } })),
      exited.then(() => { throw Error(`Preview exited before readiness: ${errors}`); }),
    ]);
    return { child, ready, exited, async stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); return exited; } };
  } catch (error) { child.kill('SIGTERM'); await exited; throw error; }
  finally { lines.close(); }
}

test('two actual preview processes have separate identities/state/ports and independent cleanup', { timeout: 30000 }, async () => {
  const a = await launch(); let b;
  try {
    b = await launch();
    assert.notEqual(a.ready.pid, b.ready.pid); assert.notEqual(a.ready.id, b.ready.id);
    assert.notEqual(a.ready.url, b.ready.url); assert.notEqual(a.ready.stateDirectory, b.ready.stateDirectory);
    for (const instance of [a, b]) {
      const response = await fetch(instance.ready.url); assert.equal(response.status, 200);
      assert.match(await response.text(), /interaction studies/i);
      const info = await (await fetch(new URL('/__instance', instance.ready.url))).json(); assert.equal(info.id, instance.ready.id);
      for (const path of ['/__aiui-design/site.css', '/__aiui-design/tokens.css', '/__aiui-design/@fontsource/cormorant-garamond/400.css', '/__aiui-design/@fontsource-variable/fraunces/full.css', '/053-orchestrator-overview/data-engine.js'])
        assert.equal((await fetch(new URL(path, instance.ready.url))).status, 200, path);
      const wasm = await fetch(new URL(`/__data/duckdb-wasm-assets/${instance.ready.duckdbVersion}/duckdb-eh.wasm`, instance.ready.url), { method: 'HEAD' });
      assert.equal(wasm.status, 200); assert.equal(wasm.headers.get('content-type'), 'application/wasm');
      const note = await fetch(new URL('/053-orchestrator-overview/README.md', instance.ready.url));
      assert.match(note.headers.get('content-type'), /text\/html/);
      const html = await note.text();
      assert.match(html, /<h1 id="overview-interaction-mock">Overview interaction mock<\/h1>/);
      assert.match(html, /<h2 id="[^\"]+">/);
      assert.match(html, /<strong>/);
      const raw = await fetch(new URL('/053-orchestrator-overview/README.md?raw=1', instance.ready.url));
      assert.match(raw.headers.get('content-type'), /text\/plain/);
      assert.match(await raw.text(), /^# Overview interaction mock/);
      assert.equal((await fetch(new URL('/docs/plans/agent-orchestrator/components/09-session-workspace.md', instance.ready.url))).status, 200);
      await access(`${instance.ready.stateDirectory}/instance.json`);
    }
    assert.equal((await a.stop()).code, 0);
    await assert.rejects(access(a.ready.stateDirectory), { code: 'ENOENT' }, a.ready.stateDirectory);
    assert.equal((await fetch(b.ready.url)).status, 200);
    await access(`${b.ready.stateDirectory}/instance.json`);
    assert.equal((await b.stop()).code, 0);
    await assert.rejects(access(b.ready.stateDirectory), { code: 'ENOENT' }, b.ready.stateDirectory);
  } finally { await a.stop(); await b?.stop(); }
});

test('history HTTP surface reads selected native exports without write operations', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pdum-history-http-test-'));
  await mkdir(join(directory, 'documents'));
  const entry = { version: 1, key: 'codex-synthetic', provider: 'codex', sessionId: 'fixture-1', title: 'HTTP fixture',
    source: { kind: 'synthetic-test', method: 'thread/read', capturedAt: '2026-10-19T00:00:00Z' } };
  const document = { ...entry, payload: { thread: { id: 'fixture-1', turns: [] } } };
  const catalogPath = join(directory, 'catalog.json');
  const documentPath = join(directory, 'documents', 'codex-synthetic.json');
  const catalogBytes = JSON.stringify({ version: 1, sessions: [entry] });
  const documentBytes = JSON.stringify(document);
  await writeFile(catalogPath, catalogBytes); await writeFile(documentPath, documentBytes);
  let instance;
  try {
    instance = await launch({ PDUM_HISTORY_EXPORT_DIR: directory });
    const url = path => new URL(path, instance.ready.url);
    const catalogue = await (await fetch(url('/__history/catalog'))).json();
    assert.equal(catalogue.available, true); assert.deepEqual(catalogue.sessions, [entry]);
    assert.deepEqual(await (await fetch(url('/__history/document/codex-synthetic'))).json(), document);
    assert.equal((await fetch(url('/__history/document/absent'))).status, 404);
    assert.equal((await fetch(url('/__history/document/codex-synthetic'), { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await fetch(url('/__history/document/..%2Fcatalog.json'))).status, 404);
    assert.equal(await readFile(catalogPath, 'utf8'), catalogBytes);
    assert.equal(await readFile(documentPath, 'utf8'), documentBytes);
  } finally { await instance?.stop(); await rm(directory, { recursive: true, force: true }); }
});

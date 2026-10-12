import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = join(root, 'artifacts/013-codex-browser-origin');
const binary = join(output, 'codex-app-server');
await mkdir(output, { recursive: true, mode: 0o700 });
const run = await mkdtemp(join(output, 'probe-'));
const children = [];
const servers = [];
const reports = {};
const build = JSON.parse(await readFile(join(output, 'build-result.json'), 'utf8'));
const evidence = { startedAt: new Date().toISOString(), binary, binarySha256: await hash(binary), sourceRevision: build.sourceRevision, patchSha256: build.patchSha256, node: process.version, run, launches: [], handshakes: [], reports };
let websocketUrl;
let finishReports;
const reportsFinished = new Promise((resolve) => { finishReports = resolve; });
let reportTimer;
process.once('SIGINT', () => { evidence.interrupted = 'SIGINT'; finishReports(); });
process.once('SIGTERM', () => { evidence.interrupted = 'SIGTERM'; finishReports(); });

try {
  assert.equal(evidence.binarySha256, build.binarySha256, 'probe binary must match build metadata');
  const trusted = await pageServer('allowed');
  const untrusted = await pageServer('denied');
  evidence.trustedOrigin = trusted;
  evidence.untrustedOrigin = untrusted;
  const defaultServer = await launch('default', undefined);
  await check('default-native', defaultServer.port, [], 101);
  await check('default-browser', defaultServer.port, [`Origin: ${trusted}`], 403);
  const allowedServer = await launch('allowlisted', [trusted]);
  websocketUrl = `ws://127.0.0.1:${allowedServer.port}`;
  evidence.websocketUrl = websocketUrl;
  await check('allowlisted-browser', allowedServer.port, [`Origin: ${trusted}`], 101);
  await check('allowlisted-native', allowedServer.port, [], 101);
  await check('unknown-origin', allowedServer.port, [`Origin: ${untrusted}`], 403);
  await check('null-origin', allowedServer.port, ['Origin: null'], 403);
  await check('wildcard-origin', allowedServer.port, ['Origin: *'], 403);
  await check('duplicate-origin', allowedServer.port, [`Origin: ${trusted}`, `Origin: ${trusted}`], 403);
  await check('combined-origin', allowedServer.port, [`Origin: ${trusted},${untrusted}`], 403);
  const fixtureToken = 'spike-013-local-fixture-not-a-real-credential';
  const tokenDigest = createHash('sha256').update(fixtureToken).digest('hex');
  const authenticated = await launch('authenticated', [trusted], ['--ws-auth', 'capability-token', '--ws-token-sha256', tokenDigest]);
  await check('allowed-origin-missing-auth', authenticated.port, [`Origin: ${trusted}`], 401);
  await check('allowed-origin-valid-auth', authenticated.port, [`Origin: ${trusted}`, `Authorization: Bearer ${fixtureToken}`], 101);
  await check('unknown-origin-valid-auth', authenticated.port, [`Origin: ${untrusted}`, `Authorization: Bearer ${fixtureToken}`], 403);
  evidence.browserPages = { allowed: `${trusted}/`, denied: `${untrusted}/` };
  await save();
  console.log(JSON.stringify({ ready: true, run, ...evidence.browserPages }, null, 2));
  reportTimer = setTimeout(() => finishReports(), 240_000);
  await reportsFinished;
  clearTimeout(reportTimer);
  assert.equal(reports.allowed?.passed, true, 'allowed browser must initialize');
  assert.equal(reports.denied?.passed, true, 'untrusted browser must fail the upgrade');
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error);
  evidence.passed = false;
  process.exitCode = 1;
} finally {
  clearTimeout(reportTimer);
  evidence.finishedAt = new Date().toISOString();
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(children.map(async ({ child, name, getLog }) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve));
    clearTimeout(timeout);
    await writeFile(join(run, `${name}.log`), getLog(), { mode: 0o600 });
  }));
  await save();
  console.log(JSON.stringify(evidence, null, 2));
}

async function save() {
  await writeFile(join(run, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(output, 'latest-probe.json'), `${JSON.stringify({ run }, null, 2)}\n`, { mode: 0o600 });
}

async function hash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function freePort() {
  const listener = createTcpServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function launch(name, origins, authArgs = []) {
  const home = join(run, name);
  const codexHome = join(home, '.codex');
  const temporary = join(home, 'tmp');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const env = {
    PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome,
    TMPDIR: temporary, LANG: 'en_US.UTF-8', CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: '1',
    CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
  };
  if (origins !== undefined) env.CODEX_SPIKE_ALLOWED_BROWSER_ORIGINS = JSON.stringify(origins);
  const args = ['--listen', `ws://127.0.0.1:${port}`, '--disable-plugin-startup-tasks-for-tests', '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', '-c', 'cli_auth_credentials_store="file"', ...authArgs];
  evidence.launches.push({ name, args, cwd: home, env });
  const child = spawn(binary, args, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const append = (chunk) => { log = (log + chunk.toString()).slice(-1_048_576); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.once('error', (error) => append(String(error)));
  children.push({ child, name, getLog: () => log });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${name} exited ${child.exitCode}: ${log}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(300) });
      if (response.ok) return { port };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${name} did not start: ${log}`);
}

async function check(name, port, headers, expected) {
  const status = await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let response = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('handshake timeout')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write([
      'GET / HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', ...headers, '', '',
    ].join('\r\n')));
    socket.on('data', (chunk) => {
      response += chunk.toString();
      if (response.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(Number(response.split(' ')[1]));
      }
    });
  });
  evidence.handshakes.push({ name, expected, status, passed: status === expected });
  assert.equal(status, expected, name);
}

async function pageServer(expectation) {
  const server = createHttpServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/report') {
      let body = '';
      for await (const chunk of request) {
        body += chunk.toString();
        if (body.length > 65_536) { response.writeHead(413).end(); return; }
      }
      try {
        reports[expectation] = JSON.parse(body);
        await writeFile(join(run, `browser-${expectation}.json`), `${body}\n`, { mode: 0o600 });
        await save();
        response.writeHead(200).end('recorded');
        if (reports.allowed && reports.denied) finishReports();
      } catch { response.writeHead(400).end('invalid report'); }
      return;
    }
    if (!websocketUrl) { response.writeHead(503).end('starting'); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    const template = await readFile(new URL('./browser.html', import.meta.url), 'utf8');
    response.end(template.replace('"__CONFIG__"', JSON.stringify({ expectation, websocketUrl })));
  });
  servers.push(server);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

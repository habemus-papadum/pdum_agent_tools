import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(spikeRoot, '../..');
const live = process.argv.includes('--live');
const tlsKeylog = process.argv.includes('--tls-keylog');
let oauthToken = live ? process.env.CLAUDE_CODE_OAUTH_TOKEN : undefined;
if (live && process.argv.includes('--keychain')) {
  assert.equal(process.platform, 'darwin', '--keychain requires macOS');
  const credentials = spawnSync('security', ['find-generic-password', '-a', userInfo().username, '-w', '-s', 'Claude Code-credentials'], { encoding: 'utf8', timeout: 5000 });
  if (credentials.status !== 0) throw new Error('Existing Claude Code Keychain credential was unavailable');
  try {
    const stored: unknown = JSON.parse(credentials.stdout);
    if (!stored || typeof stored !== 'object' || !('claudeAiOauth' in stored)) throw new Error();
    const account = stored.claudeAiOauth;
    if (!account || typeof account !== 'object' || !('accessToken' in account) || typeof account.accessToken !== 'string' || account.accessToken.length === 0) throw new Error();
    oauthToken = account.accessToken;
  } catch {
    throw new Error('Existing Claude Code Keychain credential had an invalid format');
  }
}
const candidateAuth = live ? oauthToken ?? process.env.ANTHROPIC_API_KEY : 'fixture-api-secret';
if (!candidateAuth) throw new Error('--live requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN; --keychain reads an existing macOS login');
const auth: string = candidateAuth;
const mode = live ? oauthToken ? 'live-oauth' : 'live-api-key' : 'local-fixture';
process.umask(0o077);
const directory = join(repositoryRoot, 'artifacts/002-claude-traffic', `${Date.now()}-${live ? 'live' : 'fixture'}`);
for (const name of ['', 'ca', 'config', 'home', 'work']) mkdirSync(join(directory, name), { recursive: true, mode: 0o700 });
const require = createRequire(import.meta.url);
const sdkDirectory = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
const sdkPackage = JSON.parse(readFileSync(join(sdkDirectory, 'package.json'), 'utf8')) as { version: string; claudeCodeVersion: string };
const processes: ChildProcess[] = [];
const secretKeys = /^(authorization|proxy-authorization|x-api-key|api_key|apikey|cookie|set-cookie|access_token|refresh_token|id_token|password|secret|token|credentials)$/i;
const scrub = (value: unknown): string => JSON.stringify(value, (key, item: unknown) => secretKeys.test(key) ? '[REDACTED]' : item).replaceAll(auth, '[REDACTED]');
let level1Bytes = 0;
let level1Dropped = 0;
function logEvent(value: unknown): void {
  const line = `${scrub(value)}\n`;
  const bytes = Buffer.byteLength(line);
  if (level1Bytes + bytes > 8 * 1024 * 1024) { level1Dropped++; return; }
  appendFileSync(join(directory, 'level1.jsonl'), line, { mode: 0o600 });
  level1Bytes += bytes;
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveReady); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
  return address.port;
}
async function waitUntil(ready: () => boolean, process: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (ready()) return;
    if (process.exitCode !== null) throw new Error('Helper process exited before ready; inspect local helper log');
    await delay(100);
  }
  throw new Error('Helper readiness deadline exceeded');
}
function helper(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const child = spawn(command, args, { cwd: repositoryRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let helperBytes = 0;
  for (const stream of [child.stdout, child.stderr]) {
    const captured: Buffer[] = [];
    stream?.on('data', (chunk: Buffer) => {
      if (helperBytes < 1024 * 1024) captured.push(chunk.subarray(0, 1024 * 1024 - helperBytes));
      helperBytes += chunk.byteLength;
    });
    stream?.on('end', () => appendFileSync(join(directory, 'helpers.log'), Buffer.concat(captured).toString().replaceAll(auth, '[REDACTED]'), { mode: 0o600 }));
  }
  processes.push(child);
  return child;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGINT');
  await Promise.race([new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())), delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

const python = join(repositoryRoot, '.venv/bin/python');
const proxyPort = await freePort();
const fixturePort = await freePort();
let sdkResult: unknown;
let sdkError: string | undefined;
const abortController = new AbortController();
const timer = setTimeout(() => abortController.abort(), 60_000);
try {
  if (!live) {
    const fixture = helper(python, [join(spikeRoot, 'python/fixture.py'), String(fixturePort)]);
    await delay(300);
    assert.equal(fixture.exitCode, null);
  }
  const proxy = helper(join(repositoryRoot, '.venv/bin/mitmdump'), [
    '--listen-host', '127.0.0.1', '--listen-port', String(proxyPort),
    '--set', `confdir=${join(directory, 'ca')}`, '--set', 'connection_strategy=lazy',
    ...(!live ? ['--set', 'upstream_cert=false'] : []),
    '--set', 'flow_detail=0', '-q', '-s', join(spikeRoot, 'python/capture.py'),
  ], { ...process.env, SPIKE_CAPTURE_DIR: directory, SPIKE_REDACT_SECRET: auth, ...(!live ? { SPIKE_FIXTURE_PORT: String(fixturePort) } : {}), ...(tlsKeylog ? { MITMPROXY_SSLKEYLOGFILE: join(directory, 'tls-keys.log') } : {}) });
  const certificate = join(directory, 'ca/mitmproxy-ca-cert.pem');
  await waitUntil(() => existsSync(certificate) && existsSync(join(directory, 'level2.jsonl')), proxy);
  await delay(200);
  if (!live) {
    const fixtures = spawnSync(python, [join(spikeRoot, 'python/check_fixtures.py'), String(proxyPort), directory], { encoding: 'utf8', timeout: 20_000 });
    writeFileSync(join(directory, 'fixture-checks.json'), fixtures.stdout || '{}', { mode: 0o600 });
    if (fixtures.status !== 0) throw new Error(`Fixture checks failed: ${fixtures.stderr}`);
  }
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(directory, 'home'),
    TMPDIR: process.env.TMPDIR,
    CLAUDE_CONFIG_DIR: join(directory, 'config'),
    ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: auth } : { ANTHROPIC_API_KEY: auth }),
    ...(!live ? { ANTHROPIC_BASE_URL: 'https://fixture.agent-spike.invalid' } : {}),
    HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl, http_proxy: proxyUrl, NO_PROXY: '', no_proxy: '',
    NODE_EXTRA_CA_CERTS: certificate,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    API_TIMEOUT_MS: '15000',
    ANTHROPIC_LOG: 'error',
  };
  const session = query({
    prompt: 'Reply with exactly SPIKE_FIXTURE_OK. Do not use tools.',
    options: {
      cwd: join(directory, 'work'), env: environment,
      settingSources: [], strictMcpConfig: true, mcpServers: {}, tools: [],
      persistSession: false, includePartialMessages: true,
      model: 'claude-haiku-4-5-20251001', maxTurns: 1,
      maxBudgetUsd: 0.03,
      abortController,
      spawnClaudeCodeProcess: (options) => {
        const executableVersion = spawnSync(options.command, ['--version'], { env: options.env, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
        const invocation = {
          time: new Date().toISOString(), mode,
          sdkVersion: sdkPackage.version, bundledVersion: sdkPackage.claudeCodeVersion,
          executableVersion, command: options.command, args: options.args, cwd: options.cwd,
          executableSha256: createHash('sha256').update(readFileSync(options.command)).digest('hex'),
          environment: Object.fromEntries(Object.entries(options.env).map(([key, value]) => [key, /KEY|TOKEN|SECRET|PASSWORD/i.test(key) ? '[REDACTED]' : value])),
          nodeVersion: process.version, platform: process.platform, architecture: process.arch,
        };
        writeFileSync(join(directory, 'level0.json'), scrub(invocation), { mode: 0o600 });
        return spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] });
      },
      stderr: (message) => logEvent({ kind: 'stderr', message }),
    },
  });
  try {
    for await (const event of session) {
      logEvent(event);
      if (event.type === 'result') sdkResult = event;
    }
  } catch (error) {
    sdkError = error instanceof Error ? error.message : String(error);
  } finally {
    session.close();
  }
} finally {
  clearTimeout(timer);
  for (const child of processes.reverse()) await stop(child);
}
const records = readFileSync(join(directory, 'level2.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
const summary = {
  mode, directory, sdkError,
  sdkResult, level1Bytes, level1Dropped,
  level2Kinds: Object.fromEntries([...new Set(records.map((event) => String(event.kind)))].map((kind) => [kind, records.filter((event) => event.kind === kind).length])),
  protocols: [...new Set(records.map((event) => event.http_version).filter(Boolean))],
  tlsVersions: [...new Set(records.map((event) => event.tls_version).filter(Boolean))],
  tlsKeylogCreated: tlsKeylog && existsSync(join(directory, 'tls-keys.log')),
};
writeFileSync(join(directory, 'summary.json'), scrub(summary), { mode: 0o600 });
if (!live) {
  const capture = readFileSync(join(directory, 'level2.jsonl'), 'utf8');
  for (const secret of ['fixture-auth-secret', 'fixture-api-secret', 'fixture-cookie-secret', 'fixture-query-secret', 'fixture-body-secret', 'fixture-response-secret', 'fixture-ws-secret']) assert(!capture.includes(secret), `Leaked fixture secret: ${secret}`);
  assert(records.some((event) => event.kind === 'websocket' && event.from_client === true));
  assert(records.some((event) => event.kind === 'websocket' && event.from_client === false));
  assert(records.some((event) => event.kind === 'request_body' && event.truncated === true));
  assert(records.some((event) => event.kind === 'sse'));
  assert(records.some((event) => event.kind === 'response_body' && event.content_encoding === 'gzip' && event.sse_events === 6));
  const sse = records.find((event) => event.kind === 'sse');
  const end = records.find((event) => event.kind === 'response_body' && event.flow_id === sse?.flow_id);
  assert(sse && end && Number(sse.time) < Number(end.time), 'SSE must be captured before response completion');
  if (tlsKeylog) assert(summary.tlsKeylogCreated, 'Proxy did not produce requested TLS key log');
}
console.log(JSON.stringify({ directory, mode: summary.mode, protocols: summary.protocols, tlsVersions: summary.tlsVersions, level2Kinds: summary.level2Kinds, sdkSucceeded: typeof sdkResult === 'object' && sdkResult !== null && 'subtype' in sdkResult && sdkResult.subtype === 'success', sdkError }, null, 2));
assert.equal(sdkError, undefined);
assert(sdkResult && typeof sdkResult === 'object' && 'subtype' in sdkResult && sdkResult.subtype === 'success', 'SDK did not finish successfully; inspect local summary.json');

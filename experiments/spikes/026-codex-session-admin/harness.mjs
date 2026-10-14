import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const digest = data => createHash('sha256').update(data).digest('hex');
export const textInput = text => [{ type: 'text', text, text_elements: [] }];
export async function until(check, timeout = 30_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Bounded wait expired');
    await delay(20);
  }
}

/** Isolated research server. This is deliberately local to spike026, not a production SDK. */
export class Run {
  constructor(label, { isolated, artifacts, binary, overrides = [] } = {}) {
    process.umask(0o077);
    this.binary = realpathSync(binary ?? process.env.SPIKE_CODEX_BIN ?? join(homedir(), '.local/bin/codex'));
    this.artifacts = artifacts ?? join(root, 'artifacts', label, `run-${Date.now()}`);
    this.isolated = isolated ?? mkdtempSync(join(tmpdir(), 'pdum-history-'));
    this.home = join(this.isolated, 'home');
    this.codexHome = join(this.home, '.codex');
    this.work = join(this.isolated, 'work');
    for (const path of [this.artifacts, this.codexHome, this.work]) mkdirSync(path, { recursive: true });
    this.env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: this.home, CODEX_HOME: this.codexHome, TMPDIR: this.isolated, LANG: 'en_US.UTF-8' };
    this.secrets = [];
    this.clients = [];
    this.events = [];
    this.seq = 0;
    this.phase = 'initial';
    this.overrides = overrides;
    this.metadata = { date: new Date().toISOString(), binary: this.binary, sha256: digest(readFileSync(this.binary)), version: spawnSync(this.binary, ['--version'], { encoding: 'utf8' }).stdout.trim(), platform: process.platform, node: process.version, artifacts: this.artifacts, isolated: this.isolated };
    this.save('identity.json', this.metadata);
  }
  serialize(value) {
    let result = JSON.stringify(value, (key, value) => /^(accessToken|chatgptAccountId|refresh_token|id_token|email)$/.test(key) ? '[REDACTED]' : value);
    for (const secret of this.secrets) result = result.replaceAll(secret, '[REDACTED]');
    return result;
  }
  save(name, value) { writeFileSync(join(this.artifacts, name), this.serialize(value) + '\n'); }
  record(connection, direction, message) {
    const entry = { seq: ++this.seq, time: new Date().toISOString(), monotonicMs: performance.now(), phase: this.phase, connection, direction, message };
    this.events.push(entry);
    appendFileSync(join(this.artifacts, 'level1.jsonl'), this.serialize(entry) + '\n');
  }
  async start() {
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    this.url = `ws://127.0.0.1:${port}`;
    const overrides = ['model="gpt-6-luna"', 'cli_auth_credentials_store="file"', 'analytics.enabled=false', 'feedback.enabled=false', 'features.apps=false', 'features.plugins=false', 'skills.bundled.enabled=false', 'features.multi_agent=false', 'model_reasoning_effort="low"', 'web_search="disabled"', 'service_tier="default"', 'approval_policy="never"', 'sandbox_mode="danger-full-access"'];
    const args = ['app-server', '--listen', this.url, ...[...overrides, ...this.overrides].flatMap(value => ['-c', value])];
    this.save('launch.json', { ...this.metadata, args, cwd: this.work, env: this.env });
    this.process = spawn(this.binary, args, { env: this.env, cwd: this.work, stdio: ['ignore', 'pipe', 'pipe'] });
    this.closed = new Promise(resolve => this.process.once('close', resolve));
    this.process.stderr.on('data', chunk => appendFileSync(join(this.artifacts, 'stderr.log'), chunk));
    this.process.stdout.on('data', chunk => appendFileSync(join(this.artifacts, 'stdout.log'), chunk));
    for (let i = 0; i < 100; i++) {
      try { return await this.connect('A'); } catch { await delay(50); }
    }
    throw new Error('Server failed to accept WebSocket');
  }
  async connect(name) {
    const socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    const pending = new Map();
    let nextId = 0;
    const send = message => { this.record(name, 'client', message); socket.send(JSON.stringify(message)); };
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      this.record(name, 'server', message);
      if (message.method && message.id !== undefined) {
        if (client.onRequest) client.onRequest(message, send);
        else send({ id: message.id, error: { code: -32601, message: 'Research probe has no handler for this callback' } });
      } else if (message.id !== undefined) {
        const operation = pending.get(message.id);
        if (operation) { pending.delete(message.id); clearTimeout(operation.timer); operation.resolve(message); }
      }
    });
    const client = { name, socket, send, onRequest: null, rpc: (method, params = {}, timeout = 30_000) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    }) };
    client.ok = async (method, params, timeout) => {
      const reply = await client.rpc(method, params, timeout);
      assert(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
      return reply.result;
    };
    await client.ok('initialize', { clientInfo: { name: `spike_history_${name}`, version: '0.0.0' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    this.clients.push(client);
    return client;
  }
  async authenticate(client) {
    this.sourceAuth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
    const raw = readFileSync(this.sourceAuth);
    this.authHash = digest(raw);
    const auth = JSON.parse(raw).tokens;
    assert(auth?.access_token && auth?.account_id, 'Existing subscription authentication unavailable');
    this.secrets.push(auth.access_token, auth.account_id);
    await client.ok('account/login/start', { type: 'chatgptAuthTokens', accessToken: auth.access_token, chatgptAccountId: auth.account_id });
  }
  async turn(client, threadId, prompt, timeout = 90_000) {
    const begin = this.events.length;
    const result = await client.ok('turn/start', { threadId, model: 'gpt-6-luna', effort: 'low', serviceTier: 'default', input: textInput(prompt) });
    const find = () => this.events.slice(begin).find(entry => entry.direction === 'server' && entry.message.method === 'turn/completed' && entry.message.params.threadId === threadId && entry.message.params.turn.id === result.turn.id);
    try { await until(find, timeout); } catch (error) { await client.rpc('turn/interrupt', { threadId, turnId: result.turn.id }); throw error; }
    return find().message.params.turn;
  }
  usage() {
    return this.events.filter(entry => entry.direction === 'server' && entry.message.method === 'thread/tokenUsage/updated').map(entry => ({ seq: entry.seq, time: entry.time, connection: entry.connection, ...entry.message.params }));
  }
  async stop() {
    for (const client of this.clients) client.socket.close();
    this.clients = [];
    if (this.process && this.process.exitCode === null) {
      this.process.kill('SIGINT');
      await Promise.race([this.closed, delay(2000)]);
      if (this.process.exitCode === null) this.process.kill('SIGKILL');
      await this.closed;
    }
    if (this.sourceAuth) assert.equal(digest(readFileSync(this.sourceAuth)), this.authHash, 'Source authentication file changed');
    this.save('usage.json', this.usage());
  }
}

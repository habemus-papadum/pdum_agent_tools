import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

// Disposable experiment host. The browser worker owns the agent loop; this host only
// serves files and attaches a development credential to the upstream WebSocket.
const root = fileURLToPath(new URL('../../', import.meta.url));
const live = process.argv.includes('--live');
if (live && !process.env.OPENAI_API_KEY) throw Error('OPENAI_API_KEY is required in live mode');
const publicRoot = resolve(process.env.HP_PUBLIC_ROOT ?? join(root, 'spikes/040-hp-integration/dist'));
const artifacts = join(root, 'artifacts/040-hp-integration', `browser-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
const rates = { input: 0.10, cachedInput: 0.01, cacheWrite: 0.125, output: 0.50 };
const responses = new Map();
const sockets = new Set();
let nextConnection = 0;
let createCount = 0;
let createdCount = 0;
let stopped = false;
const record = (connection, direction, message) => appendFileSync(join(artifacts, 'wire.jsonl'),
  `${JSON.stringify({ ts: new Date().toISOString(), connection, direction, message })}\n`);
const cost = () => [...responses.values()].reduce((sum, r) => sum + (r.estimatedUsd ?? 0), 0);
async function saveLedger() {
  await writeFile(join(artifacts, 'ledger.json'), JSON.stringify({
    date: new Date().toISOString(), model: 'gpt-6-luna', live,
    pricing: { checkedOn: '2026-10-18', url: 'https://developers.openai.com/api/docs/models/gpt-6-luna', usdPerMillion: rates },
    bounds: { clientCreates: 12, observedResponses: 24, maxOutputTokens: 512, wallSeconds: 120, estimatedUsd: 0.10 },
    clientCreates: createCount, responsesCreated: createdCount, responses: [...responses.values()],
    estimatedUsd: cost(), actualBilledUsd: null,
    usageCoverage: createdCount === responses.size && [...responses.values()].every(r => r.usageKnown)
      ? 'all observed responses have usage' : 'incomplete: unfinished or missing response usage',
  }, null, 2));
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__spike') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ live, websocketPath: '/responses', artifacts }));
    }
    const path = resolve(publicRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!path.startsWith(publicRoot + sep)) { res.writeHead(404); return res.end(); }
    const body = await readFile(path);
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(path)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
const wss = new WebSocketServer({ server, path: '/responses' });
wss.on('connection', browser => {
  if (!live) return browser.close(1008, 'Restart experiment host with --live');
  const id = ++nextConnection;
  sockets.add(browser);
  const upstream = new WebSocket('wss://api.openai.com/v1/responses', {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, handshakeTimeout: 10_000,
  });
  sockets.add(upstream);
  const queue = [];
  upstream.on('open', () => { for (const data of queue.splice(0)) upstream.send(data); });
  browser.on('message', data => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type === 'response.create') {
        if (message.model !== 'gpt-6-luna' || !(message.max_output_tokens > 0 && message.max_output_tokens <= 512)
            || ++createCount > 12 || cost() >= 0.10) {
          browser.close(1008, 'Experiment bounds exceeded'); upstream.close(); return;
        }
      } else if (message.type !== 'response.steer') {
        browser.close(1008, 'Unsupported experiment message'); upstream.close(); return;
      }
      record(id, 'client', message);
      // ws delivers text frames as Buffer by default. Preserve text framing upstream.
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
      else queue.push(data.toString());
    } catch { browser.close(1003, 'Invalid JSON'); upstream.close(); }
  });
  upstream.on('message', data => {
    const message = JSON.parse(data.toString());
    record(id, 'server', message);
    if (message.type === 'response.created' && ++createdCount > 24) {
      browser.close(1008, 'Experiment response bound exceeded'); upstream.close(); return;
    }
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(message.type)) {
      const response = message.response;
      const usage = response.usage;
      const input = usage?.input_tokens;
      const output = usage?.output_tokens;
      const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
      const writes = usage?.input_tokens_details?.cache_write_tokens ?? 0;
      const usageKnown = Number.isFinite(input) && Number.isFinite(output);
      const standard = input <= 272000 && cached + writes <= input && response.service_tier === 'default';
      responses.set(response.id, { responseId: response.id, model: response.model, status: response.status,
        input, output, cached, writes, usageKnown, serviceTier: response.service_tier,
        estimatedUsd: usageKnown && standard ? ((input - cached - writes) * rates.input + cached * rates.cachedInput + writes * rates.cacheWrite + output * rates.output) / 1e6 : null });
      void saveLedger();
    }
    if (browser.readyState === WebSocket.OPEN) browser.send(data.toString());
  });
  upstream.on('error', error => {
    record(id, 'transport', { error: error.message });
    browser.close(1011, 'Upstream connection failed');
  });
  browser.on('error', () => upstream.close());
  browser.on('close', () => { upstream.close(); sockets.delete(browser); void saveLedger(); });
  upstream.on('close', (code, reason) => {
    record(id, 'transport', { closed: code, reason: reason.toString() });
    if (browser.readyState === WebSocket.OPEN) browser.close(1000, `Upstream closed: ${code}`);
    sockets.delete(upstream);
  });
});
let deadline;
async function stop() {
  if (stopped) return;
  stopped = true;
  clearTimeout(deadline);
  for (const socket of sockets) socket.terminate();
  wss.close(); server.close();
  await saveLedger();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
server.listen(Number(process.env.PORT ?? 0), '0.0.0.0', () => {
  console.log(JSON.stringify({ url: `http://localhost:${server.address().port}`, live, artifacts }));
  // Start paid wall limit at the first browser connection, not while operator opens UI.
  wss.once('connection', () => { deadline = setTimeout(() => void stop(), 120_000); });
});

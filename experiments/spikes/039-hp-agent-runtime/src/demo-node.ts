import { MessageChannel } from 'node:worker_threads';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from './runtime.ts';
import { FixtureConnector, echoTool } from './fixture.ts';
import { PortClient, servePort, type Port } from './protocol.ts';
import { runDemo } from './demo.ts';
import { historyRows } from './history.ts';

const runtime = new AgentRuntime({ connector: new FixtureConnector(), tools: [echoTool] });
const channel = new MessageChannel();
const stop = servePort(runtime, channel.port1 as unknown as Port);
const client = new PortClient(channel.port2 as unknown as Port);
try {
  const report = await runDemo(client);
  const out = fileURLToPath(new URL('../../../artifacts/039-hp-agent-runtime/', import.meta.url));
  await mkdir(out, { recursive: true });
  await writeFile(`${out}/journal.json`, JSON.stringify(runtime.journal));
  await writeFile(`${out}/history-rows.json`, JSON.stringify(historyRows(runtime)));
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { client.close(); stop(); channel.port1.close(); channel.port2.close(); }

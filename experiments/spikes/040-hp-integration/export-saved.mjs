import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { replay } from '../039-hp-agent-runtime/src/runtime.ts';
import { historyRows } from '../039-hp-agent-runtime/src/history.ts';

// Reproject a saved journal with the current exporter. No runtime or client is created.
const directory = resolve(process.argv[2]);
const journal = JSON.parse(await readFile(join(directory, 'journal.json'), 'utf8'));
const usages = journal.filter(e => e.kind === 'modelEvent' && e.data.event.type === 'usage')
  .map(e => ({ threadId: e.data.threadId, turnId: e.data.turnId, ts: e.ts, usage: e.data.event }));
const runId = journal.find(e => e.kind === 'runtimeStarted')?.data.runId
  ?? `capture-${createHash('sha256').update(JSON.stringify(journal)).digest('hex')}`;
const rows = historyRows({ runId, snapshots: () => replay(journal), usages });
await writeFile(join(directory, 'history-rows.json'), JSON.stringify(rows));
console.log(JSON.stringify({ schemaVersion: rows.schemaVersion, rows: Object.fromEntries(Object.entries(rows.tables).map(([k, v]) => [k, v.length])) }));

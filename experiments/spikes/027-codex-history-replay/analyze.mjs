import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Reconstruct final observed items without executing any recorded messages. */
export function analyze(events, corpus) {
  const live = new Map();
  const methods = {};
  for (const event of events) {
    if (event.direction !== 'server') continue;
    const { method, params } = event.message;
    if (method) methods[method] = (methods[method] ?? 0) + 1;
    if (method === 'item/completed') {
      const key = JSON.stringify([params.threadId, params.turnId, params.item.id]);
      live.set(key, { threadId: params.threadId, turnId: params.turnId, item: params.item });
    }
  }
  const comparison = {};
  for (const [mode, history] of Object.entries(corpus.histories)) {
    const observed = [...live.values()].filter(x => x.threadId === history.threadId);
    const stored = history.snapshots.restart.full.result.thread.turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item })));
    const types = [...new Set([...observed, ...stored].map(x => x.item.type))];
    comparison[mode] = {
      threadId: history.threadId,
      observed, stored,
      byType: Object.fromEntries(types.map(type => [type, {
        live: observed.filter(x => x.item.type === type).length,
        history: stored.filter(x => x.item.type === type).length,
        liveIds: observed.filter(x => x.item.type === type).map(x => x.item.id),
        historyIds: stored.filter(x => x.item.type === type).map(x => x.item.id),
      }])),
      itemPaginationError: history.snapshots.restart.itemsPages[0].error ?? null,
    };
  }
  return { provenance: { input: 'recorded app-server client protocol and post-restart native API snapshots', offline: true, unknownEventsPreservedIn: 'level1.jsonl', noInference: true }, methods, comparison };
}

export function render(report) {
  const lines = ['# Offline research transcript', '', 'Final item snapshots; original deltas and timestamps remain in level1.jsonl.', ''];
  for (const [mode, value] of Object.entries(report.comparison)) {
    lines.push(`## ${mode}`, '', '| Item | Live | Stored |', '| --- | ---: | ---: |');
    for (const [type, counts] of Object.entries(value.byType)) lines.push(`| ${type} | ${counts.live} | ${counts.history} |`);
    lines.push('');
    for (const entry of value.observed) {
      const item = entry.item;
      lines.push(`### ${item.type}`, '', '```json', JSON.stringify(item, null, 2), '```', '');
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2]);
  const events = readFileSync(join(directory, 'level1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const corpus = JSON.parse(readFileSync(join(directory, 'corpus.json')));
  const result = analyze(events, corpus);
  // Real-corpus checks: dropping a command or changing item identities must be visible.
  assert.equal(result.comparison.paginated.byType.commandExecution.history, 1);
  assert.equal(result.comparison.legacy.byType.commandExecution.live, 1);
  assert.equal(result.comparison.legacy.byType.commandExecution.history, 0);
  assert.deepEqual(analyze([...events, ...events], corpus).comparison, result.comparison);
  writeFileSync(join(directory, 'offline-analysis.json'), JSON.stringify(result, null, 2));
  writeFileSync(join(directory, 'offline-transcript.md'), render(result));
  console.log(JSON.stringify({ directory, comparison: Object.fromEntries(Object.entries(result.comparison).map(([k, v]) => [k, v.byType])), duplicateReplayCheck: 'passed', network: 'unused' }));
}

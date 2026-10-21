// @vitest-environment jsdom
import {afterEach, expect, it} from 'vitest';
import {cellHarness, resetControlSurface, whenReady, tick} from '@habemus-papadum/aiui-viz/testing';
import {createCells, kit} from './graph';
import {provider, catalogQuery, query, kind, selectedKey, refreshSequence} from './store';
import type {HistoryDocument} from './native';

const source = {kind: 'test', method: 'Synthetic graph fixture', capturedAt: 'fixture'};
const documents: HistoryDocument[] = [
  {key: 'claude-a', provider: 'claude', sessionId: 'a', title: 'Alpha', source, payload: {messages: [
    {uuid: 'u', message: {role: 'user', content: 'hello'}},
    {uuid: 'a', message: {role: 'assistant', content: [{type: 'text', text: 'world'}]}},
  ]}},
  {key: 'codex-b', provider: 'codex', sessionId: 'b', title: 'Beta', source, payload: {thread: {turns: [{id: 't', items: [{id: 'u', type: 'userMessage', content: [{type: 'text', text: 'second'}]}]}]}}},
];
afterEach(() => {resetControlSurface(); selectedKey.set(''); refreshSequence.set(0);});
it('reacts to every catalog/transcript dependency and uses only the local read seam', async () => {
  const calls: string[] = [];
  const h = cellHarness(() => createCells(async path => {
    calls.push(path);
    return structuredClone(path === '/__history/catalog' ? {version: 1, sessions: documents.map(({payload, ...entry}) => entry)} : documents.find(doc => path.endsWith(doc.key)));
  }));
  try {
    expect(await whenReady(h.cells.visible)).toHaveLength(2);
    provider.set('codex'); expect(await whenReady(h.cells.sources)).toHaveLength(1);
    catalogQuery.set('absent'); expect(await whenReady(h.cells.sources)).toHaveLength(0);
    catalogQuery.set('beta'); expect(await whenReady(h.cells.sources)).toHaveLength(1);
    query.set('world'); expect(await whenReady(h.cells.visible)).toHaveLength(1);
    kind.set('user'); expect(await whenReady(h.cells.visible)).toHaveLength(0);
    query.set(''); expect(await whenReady(h.cells.visible)).toHaveLength(1);
    selectedKey.set('codex-b'); expect((await whenReady(h.cells.document)).document?.key).toBe('codex-b');
    expect((await whenReady(h.cells.visible))[0].nativeId).toBe('u');
    refreshSequence.set(1); await whenReady(h.cells.catalog); await whenReady(h.cells.document);
    expect(calls.filter(path => path === '/__history/catalog')).toHaveLength(2);
    expect(calls.every(path => path === '/__history/catalog' || path.startsWith('/__history/document/'))).toBe(true);
    await kit.handle().call('set', {name: 'native-history/query', value: 'absent'});
    expect(await whenReady(h.cells.visible)).toHaveLength(0);
  } finally {h.dispose();}
});
it('makes read failure explicit while the synthetic bench remains independently selectable', async () => {
  const h = cellHarness(() => createCells(async path => {throw new Error(`Unavailable: ${path}`);}));
  try {
    expect((await whenReady(h.cells.catalog)).loadError).toContain('Unavailable');
    selectedKey.set('@specimen');
    expect((await whenReady(h.cells.document)).document?.provider).toBe('specimen');
    expect((await whenReady(h.cells.projection))?.document.source.kind).toBe('synthetic');
  } finally {h.dispose();}
});
it('ignores a superseded response and recovers from a failed document without changing identity', async () => {
  let resolveFirst!: (value: unknown) => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => {markStarted = resolve;});
  let firstSignal: AbortSignal | undefined;
  const h = cellHarness(() => createCells(async (path, signal) => {
    if (path === '/__history/catalog') return {sessions: documents};
    if (path.endsWith('claude-a')) {firstSignal = signal; markStarted(); return new Promise(resolve => {resolveFirst = resolve;});}
    if (path.endsWith('missing')) throw new Error('Document unavailable');
    return structuredClone(documents[1]);
  }));
  try {
    await started;
    selectedKey.set('codex-b');
    expect((await whenReady(h.cells.projection))?.document.key).toBe('codex-b');
    expect(firstSignal?.aborted).toBe(true);
    resolveFirst(documents[0]); await tick();
    expect(h.cells.projection.latest()?.document.key).toBe('codex-b');
    selectedKey.set('missing');
    expect((await whenReady(h.cells.document)).loadError).toContain('Document unavailable');
    expect(await whenReady(h.cells.projection)).toBeNull();
    selectedKey.set('codex-b');
    expect((await whenReady(h.cells.projection))?.document.key).toBe('codex-b');
  } finally {h.dispose();}
});

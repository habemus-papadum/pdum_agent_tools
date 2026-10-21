import {describe, expect, it} from 'vitest';
import {filterItems, imageURL, projectHistory, type HistoryDocument} from './native';
import {markdown, safeLink} from './rich';

const source = {kind: 'test', method: 'Synthetic adapter regression, not provider evidence', capturedAt: 'fixture'};
const doc = (provider: string, payload: unknown): HistoryDocument => ({key: 'test', provider, sessionId: 'session', title: 'Fixture', source, payload});
describe('native read projection', () => {
  it('preserves unknown blocks, exact native objects and source provenance', () => {
    const unknown = {type: 'future-block', vendor: {opaque: [1, 2, 3]}};
    const message = {uuid: 'uuid-1', type: 'assistant', message: {role: 'assistant', content: [unknown]}};
    const original = doc('claude', {messages: [message]});
    const projected = projectHistory(original);
    expect(projected.document).toBe(original);
    expect(projected.items[0].raw).toBe(message);
    expect(projected.items[0].blocks[0].raw).toBe(unknown);
    expect(projected.unknownBlocks).toBe(1);
    expect(projected.items[0].path).toBe('payload.messages[0]');
  });
  it('attributes Claude tool results to their native response, counting duplicate response usage once', () => {
    const payload = {messages: [
      {uuid: 'one', message: {id: 'response', role: 'assistant', model: 'model-a', usage: {input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 2}, content: [{type: 'tool_use', id: 'tool-one', name: 'Read', input: {path: 'fixture'}}]}},
      {uuid: 'two', message: {id: 'response', role: 'assistant', model: 'model-a', usage: {input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 5}, content: [{type: 'text', text: 'done'}]}},
      {uuid: 'three', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'tool-one', content: 'result'}]}},
      {uuid: 'four', message: {id: 'unknown-usage', role: 'assistant', model: 'model-b', content: [{type: 'text', text: 'No counters'}]}},
    ]};
    const projected = projectHistory(doc('claude', payload));
    expect(projected.ledger.requests).toHaveLength(2);
    expect(projected.ledger.knownRequests).toBe(1);
    expect(projected.ledger.input).toBe(20);
    expect(projected.ledger.cachedInput).toBe(80); // Separate field; not forced inside input.
    expect(projected.ledger.output).toBe(5);
    expect(projected.ledger.requests[0].model).toBe('model-a');
    expect(projected.items[2].parentRequestId).toBe('response');
    expect(projected.items[2].usage).toBeNull();
    expect(filterItems(projected.items, '', 'tool').map(item => item.nativeId)).toEqual(['one', 'three']);
    expect(projected.ledger.cost).toBeNull();
    expect(projected.ledger.context).toBeNull();
    expect(payload.messages[0].message.usage?.output_tokens).toBe(2);
  });
  it('keeps Codex command, change, child and unknown records without invented usage', () => {
    const projection = projectHistory(doc('codex', {thread: {turns: [{id: 'turn-a', items: [
      {id: 'u', type: 'userMessage', content: [{type: 'text', text: 'Search fixture'}]},
      {id: 'cmd', type: 'commandExecution', command: 'printf fixture', aggregatedOutput: 'fixture', exitCode: 0, status: 'completed'},
      {id: 'child', type: 'collabAgentToolCall', receiverThreadIds: ['child-a'], agentsStates: {'child-a': {status: 'completed'}}},
      {id: 'opaque', type: 'future-item', nativeField: true},
    ]}]}}));
    expect(projection.items).toHaveLength(4);
    expect(projection.items[1].blocks.map(block => block.kind)).toEqual(['code', 'result']);
    expect(projection.items[2].childIds).toEqual(['child-a']);
    expect(projection.items[3].blocks[0].raw).toMatchObject({nativeField: true});
    expect(projection.ledger.input).toBeNull();
    expect(filterItems(projection.items, 'fixture', 'user')).toHaveLength(1);
    expect(filterItems(projection.items, 'cmd', 'tool')).toHaveLength(1);
  });
  it('never turns a native page absence into fabricated records', () => {
    const projection = projectHistory(doc('codex', {thread: {}, turnPages: [{data: []}]}));
    expect(projection.items).toEqual([]);
    expect(projection.warnings).toHaveLength(1);
  });
});
describe('rich presentation', () => {
  it('parses Markdown, fenced code and both math forms with source intact', () => {
    const tokens = markdown.lexer('A **claim** and $x^2$.\n\n$$\ny = x^2\n$$\n\n```mermaid\ngraph LR\nA-->B\n```');
    expect(tokens.map(token => token.type)).toContain('displayMath');
    expect(JSON.stringify(tokens)).toContain('inlineMath');
    expect(tokens.find(token => token.type === 'code')).toMatchObject({lang: 'mermaid', text: 'graph LR\nA-->B'});
  });
  it('does not execute or retrieve native payload links as a side effect', () => {
    expect(safeLink('javascript:alert(1)')).toBeUndefined();
    expect(imageURL('https://private.example/image.png')).toBeUndefined();
    expect(imageURL('file:///private/image.png')).toBeUndefined();
    expect(imageURL('/__history/assets/local.png')).toBe('/__history/assets/local.png');
    expect(safeLink('https://example.com')).toBe('https://example.com');
  });
});

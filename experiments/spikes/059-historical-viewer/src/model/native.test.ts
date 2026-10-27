import {describe, expect, it} from 'vitest';
import {filterItems, imageURL, projectHistory, recognizedClaudeOperation, resolveImage, type HistoryDocument} from './native';
import {narrative} from './presentation';
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
  it('joins producer clocks by both turn and item identity without manufacturing clocks from turn seconds', () => {
    const raw = {id:'same',type:'commandExecution',durationMs:12};
    const projection=projectHistory(doc('codex',{thread:{turns:[
      {id:'a',startedAt:1234,completedAt:1240,items:[raw]},
      {id:'b',startedAt:1234,items:[{id:'same',type:'commandExecution',durationMs:0}]},
      {items:[{type:'agentMessage',text:'No identity'}]},
    ]},itemPages:[{result:{data:[{turnId:'a',item:raw,startedAtMs:0,completedAtMs:300}]}}]}));
    expect(projection.items[0].timing).toEqual({startedAtMs:0,completedAtMs:300,reportedDurationMs:12});
    expect(projection.items[1].timing).toEqual({startedAtMs:null,completedAtMs:null,reportedDurationMs:0});
    expect(projection.items[2].timing).toEqual({startedAtMs:null,completedAtMs:null,reportedDurationMs:null});
    expect(projection.items[0].raw).toBe(raw);
  });
  it('marks conflicting producer clocks unknown and retains native records', () => {
    const item={id:'x',type:'agentMessage',text:'Answer'}, records=[
      {turnId:'t',item,startedAtMs:1,completedAtMs:2},{turnId:'t',item,startedAtMs:10,completedAtMs:20}];
    const projection=projectHistory(doc('codex',{thread:{turns:[{id:'t',items:[item]}]},itemPages:[{result:{data:records}}]}));
    expect(projection.items[0].timing.startedAtMs).toBeNull();
    expect(projection.warnings.join(' ')).toContain('Conflicting');
    expect(records[1].startedAtMs).toBe(10);
  });
  it('distinguishes child creation settings, actor settings and recurring child outcomes', () => {
    const projection=projectHistory(doc('codex',{thread:{model:'parent-model',turns:[{id:'t',items:[
      {id:'child',type:'subAgentActivity',kind:'started',agentThreadId:'child-id',model:'child-model'},
      {id:'done',type:'subAgentActivity',kind:'completed',agentThreadId:'child-id'},
      {id:'answer',type:'agentMessage',text:'Answer',model:'response-model',phase:'final_answer'},
    ]}]}}));
    expect(projection.items[0]).toMatchObject({model:'child-model',modelScope:'child-creation',childIds:['child-id']});
    expect(projection.items[1].operation).toMatchObject({label:'Child work completed',basis:'native',targetAgentId:'child-id'});
    expect(projection.items[1].model).toBeNull();
    expect(projection.items[2]).toMatchObject({model:'response-model',modelScope:'actor-response',phase:'final_answer'});
  });
  it('preserves Claude stop reasons separately and recognizes only qualified operation notices', () => {
    const projection=projectHistory(doc('claude',{messages:[
      {message:{id:'response',role:'assistant',stop_reason:'end_turn',model:'actor',content:[{type:'text',text:'Response'}]}},
      {message:{role:'user',content:'<command-name>/compact</command-name><command-args>retain findings</command-args>'}},
      {message:{role:'user',content:'<task-notification><task-id>job</task-id><status>failed</status><summary>Exited</summary></task-notification>'}},
      {message:{role:'assistant',content:[{type:'tool_use',id:'call',name:'Bash',input:{run_in_background:true}}]}},
    ]}));
    expect(projection.items[0]).toMatchObject({phase:null,messageDisposition:'end_turn',modelScope:'actor-response'});
    expect(projection.items[1].operation).toMatchObject({kind:'compact-command',basis:'recognized-text'});
    expect(projection.items[2].operation).toMatchObject({kind:'task-notification',taskId:'job',reportedStatus:'failed'});
    expect(projection.items[3].operation).toMatchObject({kind:'background-request',basis:'native'});
    expect(projection.items[3].operation?.taskId).toBeUndefined(); // Tool call ID is not a background-job ID.
    expect(filterItems(projection.items,'','event')).toHaveLength(3);
    expect(filterItems(projection.items,'','error')).toHaveLength(1);
    expect(recognizedClaudeOperation('Documentation: <command-name>/compact</command-name>')).toBeNull();
    expect(recognizedClaudeOperation('```xml\n<task-notification><status>failed</status></task-notification>\n```')).toBeNull();
  });
});
describe('rich presentation', () => {
  it('preserves native tool image origin and keeps bytes out of the text/search projection', () => {
    const image = {type:'image',mimeType:'image/png',data:'AAAA'};
    const codex = projectHistory(doc('codex',{thread:{turns:[{items:[{type:'mcpToolCall',result:{content:[image]}}]}]}}));
    expect(codex.items[0].blocks.find(block=>block.kind==='image')).toMatchObject({url:'data:image/png;base64,AAAA',origin:'Tool output',raw:image});
    expect(codex.items[0].search).not.toContain('AAAA');
    const claude = projectHistory(doc('claude',{messages:[{message:{role:'user',content:[{type:'tool_result',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:'AAAA'}}]}]}}]}));
    expect(narrative(claude.items[0])).toBe(false);
    expect(claude.items[0].blocks.find(block=>block.kind==='image')?.origin).toBe('Tool output');
  });
  it('resolves only exported asset references and preserves their historical qualification', () => {
    const path = `assets/${'a'.repeat(64)}.png`, original={kind:'image' as const,reference:'/tmp/screenshot.png',raw:{path:'/tmp/screenshot.png'}};
    const resolved=resolveImage(original,[{reference:original.reference,path}]);
    expect(resolved.url).toBe(`/__history/${path}`);
    expect(resolved.qualification).toContain('historical byte equality unverified');
    expect(resolved.raw).toBe(original.raw);
    expect(resolveImage(original,[])).toBe(original);
  });
  it('parses provider-style escaped math delimiters', () => {
    const tokens=markdown.lexer('Inline \\(x^2\\).\n\n\\[\ny=x^2\n\\]\n');
    expect(JSON.stringify(tokens)).toContain('inlineMath');
    expect(tokens.some(token=>token.type==='displayMath')).toBe(true);
  });
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

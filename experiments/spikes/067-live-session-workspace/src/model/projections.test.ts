import {describe,it,expect} from 'vitest';
import {projectLive,projectHistory,compareProjections} from './projections';
import type {HistoryDocument,Provider,WireRecord} from './types';

// Small native-shaped regression cases; these are not upstream compatibility evidence.
const wire=(provider:Provider,messages:any[]):WireRecord[]=>messages.map((entry,seq)=>({provider,seq,
  receivedAt:'2026-10-25T00:00:00Z',direction:entry.direction??'in',message:entry.direction?entry.message:entry}));
const document=(provider:Provider,payload:any):HistoryDocument=>({version:1,key:'test',provider,sessionId:'session',title:'Test',source:{kind:'synthetic-regression',method:'test',capturedAt:'2026-10-25'},payload});

describe('067 source projections',()=>{
  it('Codex collapses receipt/echo and replaces text/output deltas with authoritative completed items',()=>{
    const result=projectLive('codex',wire('codex',[
      {direction:'local',message:{type:'local/user',id:'local-user',text:'Read file'}},
      {direction:'out',message:{id:1,method:'turn/start',params:{input:[{type:'text',text:'Read file'}]}}},
      {method:'item/started',params:{turnId:'t',item:{id:'u',type:'userMessage',content:[{type:'text',text:'Read file'}]}}},
      {method:'item/completed',params:{turnId:'t',item:{id:'u',type:'userMessage',content:[{type:'text',text:'Read file'}]}}},
      {method:'item/started',params:{turnId:'t',item:{id:'a',type:'agentMessage',text:''}}},
      {method:'item/agentMessage/delta',params:{turnId:'t',itemId:'a',delta:'Hel'}},
      {method:'item/agentMessage/delta',params:{turnId:'t',itemId:'a',delta:'lo'}},
      {method:'item/completed',params:{turnId:'t',item:{id:'a',type:'agentMessage',text:'Hello.',phase:'final_answer'}}},
      {method:'item/started',params:{turnId:'t',item:{id:'tool',type:'commandExecution',command:'cat sample.txt',status:'inProgress'}}},
      {method:'item/commandExecution/outputDelta',params:{turnId:'t',itemId:'tool',delta:'value'}},
      {method:'item/completed',params:{turnId:'t',item:{id:'tool',type:'commandExecution',command:'cat sample.txt',aggregatedOutput:'value\n',status:'completed',exitCode:0}}},
    ]));
    expect(result.items).toHaveLength(3);
    expect(result.items.filter(i=>i.role==='user')).toHaveLength(1);
    expect(result.items.find(i=>i.nativeId==='a')).toMatchObject({text:'Hello.',phase:'final_answer'});
    expect(result.items.find(i=>i.nativeId==='tool')?.text.match(/value/g)).toHaveLength(1);
  });

  it('repeated identical prompts reconcile once each, and native usage is a snapshot rather than a sum',()=>{
    const result=projectLive('codex',wire('codex',[
      {direction:'local',message:{type:'local/user',id:'one',text:'Again'}},
      {method:'item/completed',params:{turnId:'a',item:{id:'u1',type:'userMessage',content:[{type:'text',text:'Again'}]}}},
      {direction:'local',message:{type:'local/user',id:'two',text:'Again'}},
      {method:'item/completed',params:{turnId:'b',item:{id:'u2',type:'userMessage',content:[{type:'text',text:'Again'}]}}},
      ...[1,2].map(()=>({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{inputTokens:100,cachedInputTokens:80,outputTokens:20},last:{totalTokens:60},modelContextWindow:1000}}})),
    ]));
    expect(result.items.filter(i=>i.role==='user')).toHaveLength(2);
    expect(result.usage).toMatchObject({input:100,inputBasis:'includes-cache',cached:80,output:20,context:60,contextWindow:1000});
    expect(result.usage.costUsd).toBeUndefined();
  });

  it('Claude stream blocks and final messages do not double-render or double-charge',()=>{
    const event=(event:any)=>({type:'stream_event',event});
    const result=projectLive('claude',wire('claude',[
      {direction:'local',message:{type:'local/user',id:'user-uuid',text:'Read this'}},
      {type:'user',uuid:'user-uuid',message:{role:'user',content:'Read this'}},
      event({type:'message_start',message:{id:'r1',usage:{input_tokens:10}}}),
      event({type:'content_block_start',index:0,content_block:{type:'text',text:''}}),
      event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Checking.'}}),
      event({type:'content_block_start',index:1,content_block:{type:'tool_use',id:'call1',name:'Read',input:{}}}),
      event({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"file_path":"sample.txt"}'}}),
      {type:'assistant',uuid:'assistant1',message:{id:'r1',role:'assistant',stop_reason:'tool_use',usage:{input_tokens:10,output_tokens:4},content:[{type:'text',text:'Checking.'},{type:'tool_use',id:'call1',name:'Read',input:{file_path:'sample.txt'}}]}},
      {type:'user',uuid:'result1',message:{role:'user',content:[{type:'tool_result',tool_use_id:'call1',content:'file bytes'}]}},
      ...[1,2].map(()=>({type:'result',uuid:'turn-result',subtype:'success',is_error:false,total_cost_usd:.1,usage:{input_tokens:10,output_tokens:4},modelUsage:{haiku:{inputTokens:10,outputTokens:4,cacheReadInputTokens:5,cacheCreationInputTokens:2,contextWindow:1000}}})),
      {type:'result',uuid:'turn-result2',subtype:'success',is_error:false,total_cost_usd:.15,modelUsage:{haiku:{inputTokens:14,outputTokens:6,cacheReadInputTokens:8,cacheCreationInputTokens:2,contextWindow:1000}}},
    ]));
    expect(result.items.filter(i=>i.role==='user')).toHaveLength(1);
    expect(result.items.filter(i=>i.text==='Checking.')).toHaveLength(1);
    expect(result.items.filter(i=>i.kind==='tool')).toHaveLength(2);
    expect(result.items.find(i=>i.title==='Read')?.text).not.toContain('partialInput');
    expect(result.usage).toMatchObject({input:14,inputBasis:'uncached',output:6,cached:8,cacheCreated:2,costUsd:.15,contextWindow:1000});
    expect(result.usage.context).toBeUndefined();
  });

  it('retains explicit errors and unfamiliar records without inferring success from a subtype',()=>{
    const result=projectLive('claude',wire('claude',[
      {type:'result',uuid:'error',subtype:'success',is_error:true,result:'Authentication failed',usage:{input_tokens:0,output_tokens:0},total_cost_usd:0},
      {type:'future-event',custom:{answer:42}},
    ]));
    expect(result.items.find(i=>i.id==='error')).toMatchObject({state:'error',title:'Model request failed'});
    expect(result.items.some(i=>i.kind==='unknown'&&i.raw.type==='future-event')).toBe(true);
    expect(result.usage.costUsd).toBe(0);
    expect(result.usage.context).toBeUndefined();
  });

  it('history uses the existing response-ID ledger and retains absent measurements',()=>{
    const assistant=(uuid:string)=>({type:'assistant',uuid,message:{id:'same-response',role:'assistant',content:[{type:'text',text:'Saved'}],usage:{input_tokens:3,cache_read_input_tokens:20,cache_creation_input_tokens:4,output_tokens:2}}});
    const history=projectHistory(document('claude',{messages:[assistant('one'),assistant('two')]}));
    expect(history.usage).toMatchObject({input:3,inputBasis:'uncached',cached:20,cacheCreated:4,output:2});
    expect(history.usage.costUsd).toBeUndefined();
    expect(history.usage.context).toBeUndefined();
    const comparison=compareProjections({items:[],usage:{basis:'Unknown'},notes:[]},history);
    expect(comparison.measurementRows.find(row=>row.name==='costUsd')).toEqual({name:'costUsd',live:null,history:null});
  });

  it('renders native paginated items without inventing execution state or measurements',()=>{
    const native={id:'call',type:'commandExecution',command:'cat file',aggregatedOutput:'result',status:'completed'};
    const history=projectHistory(document('codex',{thread:{id:'s',turns:[]},turnPages:[{result:{data:[{id:'turn'}]}}],itemPages:[{result:{data:[{turnId:'turn',item:native,startedAtMs:1,completedAtMs:2}]}}]}));
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({nativeId:'call',kind:'tool',source:'history'});
    expect(history.items[0]?.text).toContain('result');
    expect(history.usage.input).toBeUndefined();
    expect(history.notes.some(note=>note.includes('native pages'))).toBe(true);
  });
});

import {expect,it} from 'vitest';
import {projectFamily} from './family';import {buildTimeAxis} from './timeline';import {metricView,durationMeaning} from './map-metrics';
const source={kind:'fixture',method:'fixture',capturedAt:'',version:'fixture'};
it('deduplicates response counters within a lane and does not give unknown time a coordinate',()=>{
 const family=projectFamily([{key:'c',sessionId:'s',provider:'claude',title:'Fixture',source,payload:{messages:[
  {uuid:'one',message:{id:'response',role:'assistant',model:'m',usage:{input_tokens:10,cache_read_input_tokens:20,output_tokens:3},content:'a'}},
  {uuid:'two',message:{id:'response',role:'assistant',model:'m',usage:{input_tokens:10,cache_read_input_tokens:20,output_tokens:5},content:'b'}},
 ]}}]);const axis=buildTimeAxis(family.lanes);
 const sequence=metricView(family.lanes,{track:'tokens',mode:'sequence',axis});expect(sequence.maximum).toBe(35);expect(sequence.series[0].known).toBe(1);
 const timed=metricView(family.lanes,{track:'tokens',mode:'time',axis});expect(timed.series[0].known).toBe(1);expect(timed.series[0].positioned).toBe(0);
});
it('keeps missing duration distinct from reported zero and excludes child-creation models from actor tracks',()=>{
 const family=projectFamily([{key:'x',sessionId:'s',provider:'codex',title:'Fixture',source,payload:{thread:{turns:[{id:'t',items:[
 {id:'u',type:'userMessage',content:[]},{id:'c',type:'commandExecution',durationMs:0},{id:'a',type:'subAgentActivity',kind:'started',agentThreadId:'child',model:'child-model'}]}]}}}]);
 const axis=buildTimeAxis(family.lanes);expect(durationMeaning(family.lanes[0].items[0])).toBeNull();expect(durationMeaning(family.lanes[0].items[1])).toBe('Reported tool elapsed');
 expect(metricView(family.lanes,{track:'duration',mode:'sequence',axis}).series[0].known).toBe(1);
 expect(metricView(family.lanes,{track:'model',mode:'sequence',axis}).models).toEqual([]);
 expect(metricView(family.lanes,{track:'cost',mode:'sequence',axis}).series[0].known).toBe(0);
});
it('keeps a model color stable when other lanes are hidden',()=>{
 const docs=['alpha','zeta'].map((model,index)=>({key:`c${index}`,sessionId:`s${index}`,provider:'claude',title:'Fixture',source,payload:{messages:[{uuid:'m',message:{id:`r${index}`,role:'assistant',model,content:'answer'}}]}}));
 const lanes=projectFamily(docs).lanes,axis=buildTimeAxis(lanes);
 const all=metricView(lanes,{track:'model',mode:'sequence',axis});
 const one=metricView([lanes[1]],{track:'model',mode:'sequence',axis});
 expect(one.series[0].paths[0].kind).toBe(all.series[1].paths[0].kind);
});

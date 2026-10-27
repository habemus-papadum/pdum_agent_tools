import {expect, it} from 'vitest';
import {projectHistory} from './native';
import {displayRows, excerpt, formatDuration, itemWindow, mapBins, narrative, phaseLabel, pillLabel} from './presentation';
const items = () => projectHistory({key: 'fixture', provider: 'codex', sessionId: 's', title: 'Synthetic test', source: {kind:'test', method:'fixture',capturedAt:''}, payload:{thread:{turns:[{id:'t',items:[
  {id:'u',type:'userMessage',content:[{type:'text',text:'User request'}]},
  {id:'c',type:'commandExecution',command:'printf hello',status:'completed',exitCode:0},
  {id:'f',type:'fileChange',changes:[{path:'/tmp/example.txt',diff:'+hello'}]},
  {id:'a',type:'agentMessage',text:'Progress',phase:'commentary'},
  {id:'b',type:'agentMessage',text:'Answer',phase:'final_answer'},
  {id:'x',type:'agentMessage',text:'Unknown phase'},
]}]}}}).items;
it('packs consecutive work without changing native order or identity', () => {
  const source=items(), rows=displayRows(source);
  expect(rows.map(row=>row.items.length)).toEqual([1,2,1,1,1]);
  expect(rows.flatMap(row=>row.items)).toEqual(source);
  expect(rows[1].items[0]).toBe(source[1]);
});
it('uses explicit native phase and never labels the last message final by position', () => {
  expect(items().slice(3).map(phaseLabel)).toEqual(['update','final',null]);
});
it('optionally packs qualified updates and operation notices without reordering prose',()=>{
  const source=items();
  expect(displayRows(source,{updatesAsPills:true}).map(row=>row.items.length)).toEqual([1,3,1,1]);
  expect(displayRows(source,{updatesAsPills:true}).flatMap(row=>row.items)).toEqual(source);
  const notice={...source[0],operation:{kind:'compact-command',label:'Compact requested',basis:'recognized-text' as const}};
  expect(narrative(notice)).toBe(false);
  expect(pillLabel(notice)).toBe('Compact requested');
  const claude={...source[5],phase:null,messageDisposition:'end_turn'};
  expect(narrative(claude,{updatesAsPills:true})).toBe(true);
  expect(phaseLabel(claude)).toBeNull();
});
it('keeps zero duration distinct from unknown and uses useful units',()=>{
  expect(formatDuration(null)).toBe('unknown');expect(formatDuration(0)).toBe('0 ms');
  expect(formatDuration(1250)).toBe('1.3 s');expect(formatDuration(90000)).toBe('1.5 min');
});
it('windows and maps all records without truncating the source, including the last jump', () => {
  const source=Array.from({length:10003},(_,i)=>({...items()[0],id:String(i)}));
  const map=mapBins(source);
  expect(map.length).toBeLessThanOrEqual(160);
  expect(map.at(-1)?.end).toBe(source.length);
  const last=itemWindow(source,10002);
  expect(last.items[0].id).toBe('10002');
  expect(last.end).toBe(source.length);
  expect(source).toHaveLength(10003);
  expect(excerpt({...source[0],blocks:[{kind:'markdown',text:'x'.repeat(10000),raw:null}]})).toHaveLength(241);
});

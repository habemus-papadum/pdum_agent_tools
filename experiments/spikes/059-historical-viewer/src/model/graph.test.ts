// @vitest-environment jsdom
import {afterEach, expect, it} from 'vitest';
import {cellHarness, resetControlSurface, whenReady, tick} from '@habemus-papadum/aiui-viz/testing';
import {createCells, kit} from './graph';
import {provider, catalogQuery, query, kind, selectedKey, refreshSequence, focus, windowStart, windowSize,selectedFamilyId,selectedLanes,mapAxis,requestedExample} from './store';
import type {HistoryDocument} from './native';

const source = {kind: 'test', method: 'Synthetic graph fixture', capturedAt: 'fixture'};
const documents: HistoryDocument[] = [
  {key: 'claude-a', provider: 'claude', sessionId: 'a', title: 'Alpha', source, payload: {messages: [
    {uuid: 'u', message: {role: 'user', content: 'hello'}},
    {uuid: 'a', message: {role: 'assistant', content: [{type: 'text', text: 'world'}]}},
  ]}},
  {key: 'codex-b', provider: 'codex', sessionId: 'b', title: 'Beta', source, payload: {thread: {turns: [{id: 't', items: [{id: 'u', type: 'userMessage', content: [{type: 'text', text: 'second'}]}]}]}}},
];
afterEach(() => {resetControlSurface(); requestedExample.set('');selectedFamilyId.set('');selectedLanes.set(null);selectedKey.set(''); refreshSequence.set(0); windowStart.set(0); focus.set({id:'',sequence:0});});
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
    expect(calls.every(path => path === '/__history/catalog' || path === '/__history/families' || path.startsWith('/__history/document/'))).toBe(true);
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
it('navigates and filters beyond a mounted window without losing native identity or the full projection', async () => {
  const document: HistoryDocument = {...documents[0],payload:{messages:Array.from({length:433},(_,i)=>({uuid:`native-${i}`,message:{role:'user',content:`Item ${i}`}}))}};
  const h=cellHarness(()=>createCells(async path=>structuredClone(path==='/__history/catalog'?{sessions:[document]}:document)));
  try {
    expect((await whenReady(h.cells.window)).items).toHaveLength(80);
    const all=(await whenReady(h.cells.projection))!;
    focus.set({id:all.items[432].id,sequence:1});
    expect((await whenReady(h.cells.window)).items.at(-1)?.nativeId).toBe('native-432');
    windowSize.set(160); expect((await whenReady(h.cells.window)).start).toBe(320);
    focus.set({id:'',sequence:2}); windowStart.set(160);
    expect((await whenReady(h.cells.window)).items[0].nativeId).toBe('native-160');
    query.set('Item 432'); expect((await whenReady(h.cells.visible))).toHaveLength(1);
    expect((await whenReady(h.cells.window)).items[0]).toBe(all.items[432]);
    expect((await whenReady(h.cells.projection))?.items).toHaveLength(433);
    expect((await whenReady(h.cells.map))).toHaveLength(1);
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
it('selects family actors by unique key despite shared native session ID, with no per-actor refetch',async()=>{
 const main={...documents[0],key:'claude-main',source:{...source,version:'fixture',relation:{kind:'root'}}};
 const child={...documents[0],key:'claude-child',source:{...source,version:'fixture',relation:{kind:'subagent',agentId:'agent-one',parentAgentIds:[],parentToolUseIds:[]}}};
 const bundle={version:1,id:'family',title:'Fixture',provider:'claude',available:true,rootKey:main.key,members:[main,child],documents:[main,child]};
 const calls:string[]=[];
 const h=cellHarness(()=>createCells(async path=>{calls.push(path);if(path==='/__history/families')return {families:[bundle]};if(path==='/__history/catalog')return {sessions:[main]};if(path==='/__history/family/family')return structuredClone(bundle);return main;}));
 try{
   await whenReady(h.cells.families);selectedFamilyId.set('family');selectedKey.set(main.key);
   expect((await whenReady(h.cells.family))?.lanes).toHaveLength(2);
   selectedKey.set(child.key);expect((await whenReady(h.cells.projection))?.document.key).toBe(child.key);
   expect(calls.filter(path=>path==='/__history/family/family')).toHaveLength(1);
   selectedLanes.set([child.key]);expect((await whenReady(h.cells.lanes))).toHaveLength(1);
   mapAxis.set('time');expect((await whenReady(h.cells.navigation))[0].positionedItems).toBe(0);
   expect((await whenReady(h.cells.timeAxis)).unknownItems).toBe(2);
   selectedLanes.set([]);expect(await whenReady(h.cells.lanes)).toEqual([]);
   selectedLanes.set(null);expect((await whenReady(h.cells.lanes))).toHaveLength(2);
 }finally{h.dispose();}
});
it('rejects a late family response after switching selection and retains an explicit failed family identity',async()=>{
 let resolveFirst!:(value:unknown)=>void;let markStarted!:()=>void;const started=new Promise<void>(resolve=>{markStarted=resolve;});let signal:AbortSignal|undefined;
 const h=cellHarness(()=>createCells(async(path,abort)=>{
   if(path==='/__history/catalog')return {sessions:documents};if(path==='/__history/families')return {families:[]};
   if(path.endsWith('/slow')){signal=abort;markStarted();return new Promise(resolve=>{resolveFirst=resolve;});}
   if(path.endsWith('/bad'))throw new Error('Family unavailable');return structuredClone(documents[0]);
 }));
 try{
   selectedFamilyId.set('slow');await started;selectedFamilyId.set('bad');
   expect((await whenReady(h.cells.familyResult)).loadError).toContain('Family unavailable');expect(signal?.aborted).toBe(true);
   resolveFirst({id:'slow',available:true,documents:[documents[0]],rootKey:documents[0].key});await tick();
   expect((await whenReady(h.cells.document)).requestedKey).toBe('');expect(await whenReady(h.cells.projection)).toBeNull();
   selectedFamilyId.set('');expect((await whenReady(h.cells.projection))?.document.key).toBe(documents[0].key);
 }finally{h.dispose();}
});
it('derives an initial linked example without writing back into its request or explicit focus',async()=>{
 const document=documents[1],point={id:'example',label:'Example',documentKey:document.key,provider:'codex',role:'user',phase:null,turnId:'t',itemId:'u',uuid:null,features:['text']};
 const bundle={version:1,id:'examples',title:'Examples',provider:'mixed',available:true,groupKind:'collection',rootKey:document.key,bookmarks:[point],initialBookmarkId:'example',documents:[document]};
 const h=cellHarness(()=>createCells(async path=>path==='/__history/families'?{families:[bundle]}:path==='/__history/catalog'?{sessions:[document]}:path.includes('/family/')?bundle:document));
 try{
   selectedFamilyId.set('examples');requestedExample.set('@initial');
   expect((await whenReady(h.cells.readerFocus)).id).toBe(`${document.key}:0:0`);
   expect((await whenReady(h.cells.readerFocus)).align).toBe('start');
   expect((await whenReady(h.cells.projection))?.document.key).toBe(document.key);
   expect(selectedKey.get()).toBe('');expect(requestedExample.get()).toBe('@initial');expect(focus.get().sequence).toBe(0);
   focus.set({id:'manual-selection',sequence:1});expect((await whenReady(h.cells.readerFocus)).id).toBe('manual-selection');
 }finally{h.dispose();}
});

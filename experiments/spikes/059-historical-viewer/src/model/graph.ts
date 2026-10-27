import {action, agentToolkit, cell, hotCellGraph, registerStandardTools} from '@habemus-papadum/aiui-viz';
import {filterCatalog, filterItems, projectHistory, type HistoryCatalog, type HistoryDocument, type HistoryEntry} from './native';
import {projectFamily, laneStats, familyUsage, type FamilyManifest, type FamilyLane} from './family';
import {buildTimeAxis, timelineGeometry, nearestTimelineItem} from './timeline';
import {metricView} from './map-metrics';
import {exampleBookmarks,resolveExample} from './examples';
import {specimen} from './specimen';
import {displayRows, itemWindow, mapBins} from './presentation';
import {appScope, provider, catalogQuery, selectedKey, query, kind, refreshSequence, focus, windowStart, windowSize, jump, expanded,
  selectedFamilyId, selectedLanes, expandedGaps, inspector, pinnedImage, updatesAsPills, mapAxis, mapTrack, compressGaps, gapMinutes,requestedExample,exampleNotice} from './store';
export type Reader = (path: string, signal: AbortSignal) => Promise<unknown>;
export interface CatalogResult extends HistoryCatalog {loadError?: string;}
export interface DocumentResult {document: HistoryDocument | null; requestedKey: string; loadError?: string;}
export interface FamilySummary extends FamilyManifest {id:string; title:string; provider:string; rootKey:string; members:HistoryEntry[]; available:boolean;}
export interface FamilyBundle extends FamilySummary {documents:HistoryDocument[];}
export interface FamilyIndex {families:FamilySummary[]; loadError?:string;}
export interface FamilyResult {bundle:FamilyBundle|null; requestedId:string; loadError?:string;}
const readExport: Reader = async (path, signal) => {
  const response = await fetch(path, {method: 'GET', signal, cache: 'no-store'});
  if (!response.ok) throw new Error(`History export unavailable (${response.status}). Run spike 058's read-only export, then refresh.`);
  return response.json();
};
/** Injectable local GET seam for deterministic projection tests; the real backend remains a captured export. */
export function createCells(read: Reader = readExport) {
  /** Local family inventory only. No agent discovery or native runtime is contacted. */
  const families = cell(() => ({revision:refreshSequence.get()}), async (_deps,ctx):Promise<FamilyIndex> => {
    try {const value=await read('/__history/families',ctx.signal) as FamilyIndex;
      if(!Array.isArray(value?.families))throw new Error('Family catalogue unavailable');return value;
    }catch(error){if(ctx.signal.aborted)throw error;return {families:[],loadError:String(error)};}
  },{scope:appScope});
  /** Whole selected family export. Missing or superseded reads never reuse the old family identity. */
  const familyResult = cell(()=>({id:selectedFamilyId.get(),revision:refreshSequence.get()}),async({id},ctx):Promise<FamilyResult>=>{
    if(!id)return {bundle:null,requestedId:id};
    try {const value=await read(`/__history/family/${encodeURIComponent(id)}`,ctx.signal) as FamilyBundle;
      if(value.version!==1||value.id!==id||value.available!==true||!Array.isArray(value.documents))throw new Error('Family export version/identity/availability mismatch');
      return {bundle:value,requestedId:id};
    }catch(error){if(ctx.signal.aborted)throw error;return {bundle:null,requestedId:id,loadError:String(error)};}
  },{scope:appScope});
  /** Native family interpretation is separate from transient actor selection and display settings. */
  const family = cell(()=>({result:familyResult()}),({result})=>result.bundle?projectFamily(result.bundle.documents,result.bundle):null,{scope:appScope});
  /** Native capture inventory. Refresh rereads the export, not the provider. */
  const catalog = cell(() => ({revision: refreshSequence.get()}), async (_deps, ctx): Promise<CatalogResult> => {
    try {
      const value = await read('/__history/catalog', ctx.signal) as HistoryCatalog;
      if (!Array.isArray(value.sessions)) throw new Error('History catalog has no sessions array');
      return value;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      return {sessions: [], loadError: String(error)};
    }
  }, {scope: appScope});
  /** Source list narrows independently from the selected transcript. */
  const sources = cell(() => ({catalog: catalog(), provider: provider.get(), query: catalogQuery.get()}),
    ({catalog, provider, query}) => filterCatalog(catalog.sessions, provider, query), {scope: appScope});
  /** Native document bytes are fetched by export key. Explicit bench selection needs no real source. */
  const document = cell(() => selectedFamilyId.get() ? {key:selectedKey.get(),family:familyResult(),example:requestedExample.get(),revision:refreshSequence.get()} : ({key: selectedKey.get() || catalog().sessions.find(entry => entry.source.corpus === 'everyday' &&
    Array.isArray((entry.source.summary as any)?.features) && (entry.source.summary as any).features.includes('mermaid'))?.key ||
    catalog().sessions[0]?.key || '',family:null,example:'', revision: refreshSequence.get()}), async ({key,family,example}, ctx): Promise<DocumentResult> => {
    if(family){
      const bookmarks=exampleBookmarks(family.bundle?.bookmarks);
      const id=example==='@initial'?family.bundle?.initialBookmarkId:example;
      const chosen=key||bookmarks.find(point=>point.id===id)?.documentKey||family.bundle?.rootKey||'';
      return {document:family.bundle?.documents.find(doc=>doc.key===chosen)??null,requestedKey:chosen,
        loadError:family.loadError||(!family.bundle?.documents.some(doc=>doc.key===chosen)?'Selected agent is unavailable in this family':undefined)};
    }
    if (key === '@specimen') return {document: structuredClone(specimen), requestedKey: key};
    if (!key) return {document: null, requestedKey: key};
    try {
      const value = await read(`/__history/document/${encodeURIComponent(key)}`, ctx.signal) as HistoryDocument;
      if (value.key !== key || !value.source || !('payload' in value)) throw new Error('Native export envelope does not match the selected key');
      return {document: value, requestedKey: key};
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      return {document: null, requestedKey: key, loadError: String(error)};
    }
  }, {scope: appScope});
  /** Source-specific readable view with original payload retained. */
  const projection = cell(() => ({result: document(),family:selectedFamilyId.get()?family():null}),
    ({result,family}) => result.document ? family?.lanes.find(lane=>lane.key===result.document!.key)?.projection??projectHistory(result.document) : null, {scope: appScope});
  /** Filtering changes presentation only; request accounting always covers the full selected capture. */
  const visible = cell(() => ({projection: projection(), query: query.get(), kind: kind.get()}),
    ({projection, query, kind}) => projection ? filterItems(projection.items, query, kind) : [], {scope: appScope});
  /** URL/startup examples are derived until an explicit reader selection takes over. */
  const initialExample = cell(()=>({group:family(),result:familyResult(),request:requestedExample.get(),key:selectedKey.get(),sequence:focus.get().sequence}),
    ({group,result,request,key,sequence})=>{
      if(!group||!result.bundle||!request||key||sequence!==0)return null;
      const bookmarks=exampleBookmarks(result.bundle.bookmarks),id=request==='@initial'?result.bundle.initialBookmarkId:request;
      const bookmark=bookmarks.find(point=>point.id===id);if(!bookmark)return id?{available:false as const,reason:'Example bookmark not found'}:null;
      return resolveExample(group.lanes,bookmark);
    },{scope:appScope});
  const readerFocus = cell(()=>({explicit:focus.get(),initial:initialExample()}),({explicit,initial})=>initial?.available?{id:initial.item.id,sequence:explicit.sequence,align:'start' as const}:explicit,{scope:appScope});
  const window = cell(() => ({items: visible(), start: windowStart.get(), size: windowSize.get(), focus: readerFocus().id}),
    ({items, start, size, focus}) => {
      const index = items.findIndex(item => item.id === focus);
      const actualStart = index >= 0 && (index < start || index >= start + size) ? Math.floor(index / size) * size : start;
      return itemWindow(items, actualStart, size);
    }, {scope: appScope});
  const rows = cell(() => ({window: window(),updatesAsPills:updatesAsPills.get()}), ({window,updatesAsPills}) => displayRows(window.items,{updatesAsPills}), {scope: appScope});
  const map = cell(() => ({items: visible()}), ({items}) => mapBins(items), {scope: appScope});
  const allLanes = cell(()=>{const group=family();return {family:group,projection:group?null:projection()};},({family,projection}):FamilyLane[]=>{
    if(family)return family.lanes;if(!projection)return [];
    const {payload:_,...entry}=projection.document;
    return [{key:entry.key,entry,projection,items:projection.items,parentKey:null,parentIdentity:null,parentStatus:'root',parentBasis:'selected-root',
      sourceVersion:typeof entry.source.version==='string'?entry.source.version:null,stats:laneStats(projection)}];
  },{scope:appScope});
  const lanes = cell(()=>({all:allLanes(),selection:selectedLanes.get()}),({all,selection})=>selection===null?all:all.filter(lane=>selection.includes(lane.key)),{scope:appScope});
  const timeAxis = cell(()=>({lanes:lanes(),compress:compressGaps.get(),minutes:gapMinutes.get(),expanded:expandedGaps.get()}),
    ({lanes,compress,minutes,expanded})=>buildTimeAxis(lanes,{gapThresholdMs:compress?minutes*60000:null,expandedGapIds:expanded}),{scope:appScope});
  const navigation = cell(()=>({lanes:lanes(),axis:timeAxis(),mode:mapAxis.get(),query:query.get(),kind:kind.get()}),
    ({lanes,axis,mode,query,kind})=>timelineGeometry(lanes,{mode:mode as 'sequence'|'time',axis,height:600,bins:160,include:item=>filterItems([item],query,kind).length>0}),{scope:appScope});
  const selectedUsage = cell(()=>({lanes:lanes()}),({lanes})=>familyUsage(lanes),{scope:appScope});
  const metrics = cell(()=>({lanes:lanes(),axis:timeAxis(),mode:mapAxis.get(),track:mapTrack.get(),query:query.get(),kind:kind.get()}),
    options=>metricView(options.lanes,{...options,mode:options.mode as 'sequence'|'time'}),{scope:appScope});
  return {catalog, sources, document, projection, visible, initialExample,readerFocus,window, rows, map,families,familyResult,family,allLanes,lanes,timeAxis,navigation,selectedUsage,metrics};
}
export const graph = hotCellGraph(appScope.name, () => createCells(), import.meta.hot);
if (import.meta.hot) import.meta.hot.accept();
/** Move through the current filtered transcript, changing reader focus only. */
export const stepItem = action({scope: appScope, name: 'step-item', group: 'navigation', params: {direction: 'next or previous'}, run: args => {
  const rows = graph().visible.latest() ?? [];
  const current = rows.findIndex(item => item.id === graph().readerFocus.latest()?.id);
  const index = Math.max(0, Math.min(rows.length - 1, current < 0 ? graph().window.latest()?.start ?? 0 : current + (args?.direction === 'previous' ? -1 : 1)));
  const item = rows[index];
  if (item) focus.set(state => ({id: item.id, sequence: state.sequence + 1}));
  return {id: item?.id ?? null};
}});
/** Move the display window; the entire exported document remains loaded. */
export const pageWindow = action({scope: appScope, name: 'page-window', group: 'navigation', params: {direction: 'next or previous'}, run: args => {
  const current = graph().window.latest(); if (!current) return;
  const next = Math.max(0, Math.min(Math.max(0, current.total - 1), current.start + (args?.direction === 'previous' ? -windowSize.get() : windowSize.get())));
  windowStart.set(next); focus.set(value => ({id: '', sequence: value.sequence + 1}));
  return {start: next};
}});
/** Jump to a full-document item index, including items outside the current display window. */
export const jumpIndex = action({scope: appScope, name: 'jump-index', group: 'navigation', params: {index: 'Zero-based index within filtered items'}, run: args => {
  const items = graph().visible.latest() ?? []; const index = Number(args?.index);
  if (!Number.isInteger(index) || !items[index]) throw new Error('Choose an existing item index');
  windowStart.set(Math.floor(index / windowSize.get()) * windowSize.get());
  jump.run({id: items[index].id}); return {id: items[index].id, index};
}});
/** Expand or collapse all items in a source-reported turn. Missing turn identity is not reconstructed. */
export const expandTurn = action({scope: appScope, name: 'expand-turn', group: 'presentation', params: {turnId: 'Native turn identity', open: 'True expands, false collapses'}, run: args => {
  const items = graph().projection.latest()?.items.filter(item => item.turnId === args?.turnId && item.turnId !== null) ?? [];
  if (!items.length) throw new Error('No captured native turn matches');
  expanded.set(values => ({...values, ...Object.fromEntries(items.map(item => [item.id, args?.open === true]))}));
  return {items: items.length};
}});
/** Expand or collapse the currently displayed window, without changing captured history. */
export const expandWindow = action({scope: appScope, name: 'expand-window', group: 'presentation', params: {open: 'True expands, false collapses'}, run: args => {
  const items = graph().window.latest()?.items ?? [];
  expanded.set(values => ({...values, ...Object.fromEntries(items.map(item => [item.id, args?.open === true]))}));
  return {items: items.length};
}});
function resetReader(key:string,itemId='') {
  selectedKey.set(key);query.set('');kind.set('all');windowStart.set(0);expanded.set({});pinnedImage.set(null);
  focus.set(value=>({id:itemId,sequence:value.sequence+1}));
}
/** Read one complete local family capture. No native agent or process is attached. */
export const openFamily = action({scope:appScope,name:'open-family',group:'history',params:{id:'Captured family id',key:'Optional member key'},run:args=>{
  const id=String(args?.id??'');const entry=graph().families.latest()?.families.find(value=>value.id===id);
  if(!entry?.available)throw new Error(entry?.reason||'Choose an available captured family');
  const key=typeof args?.key==='string'?args.key:entry.rootKey;
  if(!entry.members.some(member=>member.key===key))throw new Error('Member is not in that captured family');
  selectedFamilyId.set(id);selectedLanes.set(null);expandedGaps.set([]);resetReader(key);inspector.set('map');
  const initial=entry.groupKind==='collection'&&typeof args?.key!=='string'?String(entry.initialBookmarkId||'@initial'):'';
  requestedExample.set(initial);exampleNotice.set('');
  if(initial){selectedKey.set('');focus.set({id:'',sequence:0});}
  return {id,key,effect:'Read a local family export only'};
}});
/** Select one already loaded actor by export key, preserving the family and map lane selection. */
export const openActor = action({scope:appScope,name:'open-actor',group:'navigation',params:{key:'Family member export key',itemId:'Optional projected item identity'},run:args=>{
  const key=String(args?.key??'');const lane=graph().allLanes.latest()?.find(value=>value.key===key);
  if(!lane)throw new Error('Agent is not loaded in this family');
  const itemId=typeof args?.itemId==='string'&&lane.items.some(item=>item.id===args.itemId)?args.itemId:'';
  resetReader(key,itemId);return {key,itemId};
}});
/** Open a qualified review example by native identity and expand its actual message. */
export const openExample = action({scope:appScope,name:'open-example',group:'navigation',params:{id:'Example bookmark id'},run:args=>{
  const bundle=graph().familyResult.latest()?.bundle,group=graph().family.latest();
  if(!bundle||!group)return {available:false,reason:'The capture collection is not loaded'};
  const bookmarks=exampleBookmarks(bundle.bookmarks??(bundle.relationships as any)?.bookmarks);
  const wanted=String(args?.id??'');const id=wanted==='@initial'?String(bundle.initialBookmarkId||bookmarks[0]?.id||''):wanted;
  requestedExample.set('');
  const bookmark=bookmarks.find(value=>value.id===id);
  if(!bookmark){const reason=id?'Example bookmark not found':'';exampleNotice.set(reason);return {available:false,reason};}
  const resolved=resolveExample(group.lanes,bookmark);
  if(!resolved.available){exampleNotice.set(resolved.reason);return resolved;}
  resetReader(resolved.lane.key,resolved.item.id);expanded.set({[resolved.item.id]:true});
  selectedLanes.set([resolved.lane.key]);exampleNotice.set('');
  focus.set(value=>({id:resolved.item.id,sequence:value.sequence+1,align:'start'}));
  return {available:true,example:id,key:resolved.lane.key,itemId:resolved.item.id,effect:'Read and reveal captured native message'};
}});
/** Select the lanes used by the navigator; an empty selection stays explicitly empty. */
export const chooseLane = action({scope:appScope,name:'choose-lane',group:'navigation',params:{key:'Member key',mode:'toggle, only or all'},run:args=>{
  const all=graph().allLanes.latest()??[];const mode=String(args?.mode??'toggle');
  if(mode==='all'){selectedLanes.set(null);return {lanes:all.length};}
  const key=String(args?.key??'');if(!all.some(lane=>lane.key===key))throw new Error('Choose a loaded agent');
  const current=selectedLanes.get()??all.map(lane=>lane.key);
  const chosen=mode==='only'?[key]:current.includes(key)?current.filter(value=>value!==key):[...current,key];
  selectedLanes.set(chosen);return {lanes:chosen.length};
}});
/** Navigate by a lane's item order or the shared qualified time transform. */
export const jumpMap = action({scope:appScope,name:'jump-map',group:'navigation',params:{key:'Selected lane key',position:'Normalized position from 0 to 1'},run:args=>{
  const lane=graph().lanes.latest()?.find(value=>value.key===args?.key);if(!lane)throw new Error('Choose a visible lane');
  const position=Number(args?.position);if(!Number.isFinite(position))throw new Error('A finite position is required');
  const item=nearestTimelineItem(lane,position,{mode:mapAxis.get() as 'sequence'|'time',axis:graph().timeAxis.latest(),include:item=>filterItems([item],query.get(),kind.get()).length>0});
  if(!item)return {available:false,reason:'No matching item has a position on this axis'};
  resetReader(lane.key,item.id);return {key:lane.key,id:item.id};
}});
/** Find a concrete image, operation or error in the selected actor and reveal its first match. */
export const findKind = action({scope:appScope,name:'find-kind',group:'navigation',params:{kind:'image, event, error or all'},run:args=>{
  const value=String(args?.kind??'image');if(!['image','event','error','all'].includes(value))throw new Error('Unknown finder');
  const item=filterItems(graph().projection.latest()?.items??[],'',value)[0];
  query.set('');kind.set(value);windowStart.set(0);focus.set(current=>({id:item?.id??'',sequence:current.sequence+1}));
  if(item)expanded.set(current=>({...current,[item.id]:true}));return {found:Boolean(item),id:item?.id??null};
}});
export const kit = agentToolkit(appScope.name, {brief: 'Read-only viewer of captured native Claude SDK and Codex app-server history. All network requests are GETs to local export files. Open-history, jump, filters and inspector controls change this reader only. No turn, resume, fork, live subscription or profile write is available. @specimen is authored renderer coverage, never provider evidence.'});
registerStandardTools(kit);
kit.registerReporter('history', () => {
  const value = graph().projection.latest();
  return {readOnly: true, requestedKey: selectedKey.get(), selectedKey: value?.document.key, provider: value?.document.provider,
    documentState: graph().document.state(), projectionState: graph().projection.state(), documentError: graph().document.latest()?.loadError,
    source: value?.document.source, synthetic: value?.document.provider === 'specimen',
    catalog: graph().catalog.latest()?.sessions.map(entry => ({key: entry.key, provider: entry.provider, sessionId: entry.sessionId, title: entry.title})),
    itemCount: value?.items.length, items: graph().window.latest()?.items.map(item => ({id: item.id, nativeId: item.nativeId, role: item.role, phase: item.phase, path: item.path, blocks: item.blocks.map(block => block.kind)})),
    visible: graph().visible.latest()?.length, catalogError: graph().catalog.latest()?.loadError, focusedItem: graph().readerFocus.latest()?.id, unknownBlocks: value?.unknownBlocks,
    usage: value?.ledger, warnings: value?.warnings};
});
kit.registerReporter('family',()=>({selected:selectedFamilyId.get(),catalog:graph().families.latest()?.families.map(value=>({id:value.id,title:value.title,available:value.available,members:value.members.length})),
  state:graph().familyResult.state(),error:graph().familyResult.latest()?.loadError,
  lanes:graph().allLanes.latest()?.map(lane=>({key:lane.key,parentKey:lane.parentKey,parentStatus:lane.parentStatus,items:lane.items.length,errors:lane.stats.reportedErrors,images:lane.stats.images,timing:lane.stats.timing})),
  selectedLanes:graph().lanes.latest()?.map(lane=>lane.key),warnings:graph().family.latest()?.warnings,
  axis:mapAxis.get(),timeCoverage:graph().timeAxis.latest()?{known:graph().timeAxis.latest()!.knownItems,unknown:graph().timeAxis.latest()!.unknownItems,gaps:graph().timeAxis.latest()!.gaps}:null,
  sharedResponses:graph().family.latest()?.ledger.sharedResponses,groupKind:graph().family.latest()?.groupKind,
  examples:exampleBookmarks(graph().familyResult.latest()?.bundle?.bookmarks).map(value=>({id:value.id,label:value.label,role:value.role,phase:value.phase})),exampleNotice:exampleNotice.get()}));
// Graph hot swaps rebuild projections over surviving actor, lane, time, gap and transcript controls.

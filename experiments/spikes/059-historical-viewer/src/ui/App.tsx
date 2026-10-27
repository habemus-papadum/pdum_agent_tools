import {createEffect, createMemo, For, latest, Show} from 'solid-js';
import {CellView, ControlSelect} from '@habemus-papadum/aiui-viz';
import {JsonView} from '@habemus-papadum/aiui-viz/site/json-view';
import {TextView} from '@habemus-papadum/aiui-viz/site/markdown';
import {CommandPalette, type Command} from '../../../055-orchestrator-mock-lab/shared/CommandPalette';
import {graph, pageWindow, stepItem, expandTurn, expandWindow, openActor, openFamily, openExample, findKind} from '../model/graph';
import * as state from '../model/store';
import {formatCount, object, type Block, type HistoryEntry, type HistoryItem, type HistoryProjection} from '../model/native';
import {excerpt, failed, features, itemKind, narrative, phaseLabel, pillLabel, shortName, formatDuration} from '../model/presentation';
import {Code, RichText} from './RichText';
import {ImageAssets, ImageContent, ImageLens} from './ImageLens';
import {Icon} from './Icons';
import {FamilyChooser, FamilyMembers, FamilyMap} from './FamilyNavigator';
import {durationMeaning} from '../model/map-metrics';

function NativeLink(props: {sessionId: string; entries: HistoryEntry[]; label?: string}) {
  const matches = (entry:HistoryEntry) => {const current=graph().projection.latest()?.document;return entry.provider===current?.provider && (entry.provider==='codex' ? entry.sessionId===props.sessionId : (object(entry.source.relation).agentId===props.sessionId && entry.sessionId===current.sessionId) || (entry.sessionId===props.sessionId && !object(entry.source.relation).agentId));};
  const target = () => props.entries.find(matches);
  const otherFamily = () => graph().families.latest()?.families.find(family=>family.available&&family.members.some(matches));
  const open = () => {
    const entry=target();if(entry){if(graph().family.latest()?.lanes.some(lane=>lane.key===entry.key))openActor.run({key:entry.key});else state.openHistory.run({key:entry.key});return;}
    const family=otherFamily();if(family){const member=family.members.find(matches);openFamily.run({id:family.id,key:member!.key});}
  };
  return <Show when={target()||otherFamily()} fallback={<span class="history-unavailable" title={props.sessionId}>{props.label ?? 'Related agent'} · not captured</span>}>
    <button class="history-related" title={props.sessionId} onClick={open}><Icon kind="related"/>{props.label ?? 'Read child'}</button>
  </Show>;
}
function BlockView(props: {block: Block}) {
  const block = props.block;
  switch (block.kind) {
    case 'markdown': return <RichText text={block.text ?? ''}/>;
    case 'thinking': return <RichText text={block.text ?? ''}/>;
    case 'code': return <Code text={block.text ?? ''} language={block.language} label={block.label?.includes('/') ? shortName(block.label) : block.label}/>;
    case 'tool': return <details class="history-tool"><summary>{block.label || 'Tool call'} · arguments</summary><Show when={block.text} fallback={<JsonView value={block.raw} depth={1}/>}><Code text={block.text ?? ''} language="json"/></Show></details>;
    case 'result': return <details class="history-result"><summary>{block.label || 'Tool result'}</summary><TextView text={block.text ?? ''} markdown={false}/></details>;
    case 'image': return <ImageLens image={block}/>;
    default: return <details class="history-unknown"><summary>{block.label || 'Unknown native block'}</summary><JsonView value={block.raw} depth={1}/></details>;
  }
}
function ItemUsage(props: {item: HistoryItem}) {
  return <Show when={props.item.usage}><span class="history-item-usage" title="Native response counters. Repeated response IDs count once in the session total; tool results have no independent charge.">
    ↓ {formatCount(props.item.usage?.input ?? null)} · ↺ {formatCount(props.item.usage?.cachedInput ?? null)} · ↑ {formatCount(props.item.usage?.output ?? null)}
  </span></Show>;
}
function RawButton(props: {item: HistoryItem}) {
  return <button class="history-raw-button" title="Inspect native record and IDs" aria-label="Inspect native record" onClick={() => {state.jump.run({id: props.item.id}); state.inspector.set('raw');}}><Icon kind="raw"/></button>;
}
function Item(props: {item: HistoryItem; entries: HistoryEntry[]; ordinal: number}) {
  const item = props.item;
  const isNarrative = () => narrative(item,{updatesAsPills:state.updatesAsPills.get()});
  const kind = itemKind(item), rich = features(item), phase = phaseLabel(item);
  const disposition=item.messageDisposition==='tool_use'?'to tools':item.messageDisposition==='end_turn'?'response ended':item.messageDisposition;
  const expanded = createMemo(() => state.expanded.get()[item.id] ?? ((graph().initialExample.latest()?.available && (graph().initialExample.latest() as any).item.id===item.id) || (isNarrative() && state.density.get() === 'reading')));
  const selected = createMemo(() => graph().readerFocus.latest()?.id === item.id);
  const toggle = () => state.expandItem.run({id: item.id, open: !expanded()});
  const label = item.role === 'user' ? 'You' : item.role === 'assistant' ? 'Agent' : item.label;
  return <div class={isNarrative() ? 'history-message' : 'history-activity'} data-history-item={item.id} data-kind={kind} data-selected={selected() ? 'true' : 'false'} data-expanded={expanded() ? 'true' : 'false'} data-error={failed(item) ? 'true' : 'false'} tabindex={-1}>
    <Show when={isNarrative()} fallback={<>
      <button class="history-work-pill" onClick={toggle} aria-expanded={expanded() ? 'true' : 'false'} title={`${item.label}${item.status ? ` · ${item.status}` : ''} · expand to inspect`}>
        <Icon kind={failed(item) ? 'error' : kind}/><span>{pillLabel(item)}</span><Show when={rich.includes('image')}><span title="Contains an image"><Icon kind="image"/></span></Show><Show when={failed(item)}><b>!</b></Show><Show when={durationMeaning(item)}><small class="history-duration" title={`${durationMeaning(item)}; not CPU time or background lifetime`}>{formatDuration(item.timing.reportedDurationMs)}</small></Show><span class="history-pill-chevron">{expanded() ? '−' : '+'}</span>
      </button><Show when={item.operation?.targetAgentId && !expanded()}><NativeLink sessionId={item.operation!.targetAgentId!} entries={props.entries}/></Show>
      <Show when={expanded()}><div class="history-work-detail"><header><span>{props.ordinal + 1} · {item.label}</span><span>{item.status}</span><ItemUsage item={item}/><RawButton item={item}/></header><Show when={item.operation}><p class="history-operation-note">{item.operation!.detail || item.operation!.label} <small>· {item.operation!.basis==='native'?'native operation':'recognized recorded text'}</small></p></Show><For each={item.blocks}>{block => <BlockView block={block}/>}</For><For each={item.childIds}>{id => <NativeLink sessionId={id} entries={props.entries}/>}</For></div></Show>
    </>}>
      <div class="history-message-head"><button class="history-role" onClick={toggle} aria-expanded={expanded() ? 'true' : 'false'} title={`${expanded() ? 'Collapse' : 'Expand'} ${label.toLowerCase()} message`}><Icon kind={kind}/><b>{label}</b></button>
        <Show when={phase || disposition} fallback={<Show when={item.role === 'assistant'}><span class="history-phase unknown" title="The history source does not establish whether this is an update or final response">phase —</span></Show>}><span class={`history-phase ${phase || 'disposition'}`} title={disposition?'Native model response stop reason; query completion is not established':'Native Codex message phase'}>{phase || disposition}</span></Show>
        <Show when={!expanded()}><span class="history-message-excerpt" onClick={toggle}>{excerpt(item, state.density.get() === 'outline' ? 180 : 340)}</span></Show>
        <span class="history-rich-flags"><For each={rich}>{feature => <span title={feature}><Icon kind={feature}/></span>}</For></span><ItemUsage item={item}/><RawButton item={item}/>
        <button class="history-expand" title={expanded() ? 'Collapse message' : 'Expand message'} aria-label={expanded() ? 'Collapse message' : 'Expand message'} onClick={toggle}>{expanded() ? '−' : '+'}</button>
      </div>
      <Show when={expanded()}><div class="history-message-body"><For each={item.blocks}>{block => <BlockView block={block}/>}</For><For each={item.childIds}>{id => <NativeLink sessionId={id} entries={props.entries}/>}</For></div></Show>
      <Show when={!expanded() && state.density.get() !== 'outline' && item.blocks.some(block => block.kind === 'image')}><div class="history-inline-images"><For each={item.blocks.filter(block => block.kind === 'image')}>{block => <ImageLens image={block}/>}</For></div></Show>
    </Show>
  </div>;
}
function SourceCatalog() {
  return <aside class="history-catalog" aria-label="Captured sessions"><div class="history-panel-head"><strong>Sessions</strong><button title="Hide sessions" onClick={() => state.toggleSources.run()}>×</button></div>
    <FamilyChooser/><Show when={state.selectedFamilyId.get()} fallback={<><div class="history-source-controls"><ControlSelect of={state.provider} label="Provider"/><input type="search" aria-label="Search captured sessions" placeholder="Find a conversation…" data-control={state.catalogQuery.name} value={state.catalogQuery.get()} onInput={event => state.catalogQuery.set(event.currentTarget.value)}/></div>
    <CellView of={graph().sources} label="Reading catalog">{entries => <div class="history-source-list"><For each={['everyday', 'experiments']}>{corpus => <section><h2 class="history-provider-title">{corpus === 'everyday' ? 'Real work' : 'Small experiments'} <span>{entries().filter(entry => (entry.source.corpus === 'everyday') === (corpus === 'everyday')).length}</span></h2>
      <For each={entries().filter(entry => (entry.source.corpus === 'everyday') === (corpus === 'everyday'))}>{entry => <button class="history-session" data-selected={graph().projection.latest()?.document.key === entry.key ? 'true' : 'false'} title={entry.title} onClick={() => state.openHistory.run({key: entry.key})}>
        <span class="history-session-provider">{entry.provider === 'codex' ? 'C' : 'A'}</span><span class="history-session-copy"><strong>{entry.title || 'Untitled'}</strong><small>{entry.provider} · {typeof object(entry.source.summary).items === 'number' ? `${Number(object(entry.source.summary).items).toLocaleString()} items` : 'bounded capture'}<Show when={Array.isArray(object(entry.source.summary).features)}><span> · {(object(entry.source.summary).features as string[]).slice(0,3).join(' / ')}</span></Show></small></span>
      </button>}</For></section>}</For><Show when={graph().catalog.latest()?.loadError}><p class="history-warning" role="alert">{graph().catalog.latest()?.loadError}</p></Show><Show when={!entries().length}><p class="history-empty">No matching captures.</p></Show></div>}</CellView>
    </>}><FamilyMembers/></Show><div class="history-bench"><button onClick={() => state.openHistory.run({key: '@specimen'})}>◇ Synthetic rendering bench ↗</button><a href="/059-historical-viewer/README.md">Study notes</a></div>
  </aside>;
}
function Provenance(props: {projection: HistoryProjection; entries: HistoryEntry[]}) {
  const d = props.projection.document, coverage = object(d.source.coverage), summary = object(d.source.summary);
  const thread = object(object(d.payload).thread);
  return <div class="history-provenance"><dl><dt>Source</dt><dd>{d.provider} · {state.selectedFamilyId.get() ? (graph().family.latest()?.groupKind==='collection'?'example capture':'family capture') : d.source.corpus === 'everyday' ? 'real work' : d.provider === 'specimen' ? 'synthetic' : 'experiment'}</dd>
    <dt>Items</dt><dd>{props.projection.items.length.toLocaleString()}</dd><dt>Captured</dt><dd>{d.source.capturedAt.slice(0,19).replace('T',' ')}</dd><dt>Reader</dt><dd>{String(d.source.version ?? '—')}</dd>
    <dt>Usage</dt><dd>{props.projection.ledger.knownRequests} responses with counters</dd><dt>Cost</dt><dd>Estimator not implemented</dd><dt>Context</dt><dd>Occupancy not established</dd><dt>Unknown</dt><dd>{props.projection.unknownBlocks} native blocks retained</dd>
    <Show when={summary.bytes}><dt>Export</dt><dd>{(Number(summary.bytes)/1_000_000).toFixed(2)} MB · full document fetched</dd></Show></dl>
    <For each={['parentThreadId','forkedFromId']}>{key => <Show when={typeof thread[key] === 'string'}><NativeLink sessionId={String(thread[key])} entries={props.entries} label={key === 'forkedFromId' ? 'Fork origin' : 'Parent'}/></Show>}</For>
    <details><summary>Native identity & method</summary><code>{d.sessionId}</code><p>{d.source.method}</p></details>
    <details><summary>Coverage & measurement meaning</summary><p>{props.projection.ledger.explanation}</p><JsonView value={coverage} depth={1}/></details>
    <details><summary>Request ledger · {props.projection.ledger.requests.length}</summary><JsonView value={props.projection.ledger.requests} depth={1}/></details>
    <details><summary>All source metadata</summary><JsonView value={d.source} depth={1}/></details>
  </div>;
}
function Inspector(props: {projection: HistoryProjection; entries: HistoryEntry[]}) {
  const selected = () => props.projection.items.find(item => item.id === graph().readerFocus.latest()?.id);
  return <aside class="history-inspector" data-mode={state.inspector.get()} aria-label="History inspector"><div class="history-panel-head"><ControlSelect of={state.inspector} label="View"/><button title="Close inspector" onClick={()=>state.inspector.set('closed')}>×</button></div>
    <Show when={state.inspector.get() === 'map'}><FamilyMap/></Show>
    <Show when={state.inspector.get() === 'provenance'}><Provenance projection={props.projection} entries={props.entries}/></Show>
    <Show when={state.inspector.get() === 'image'}><div class="history-pinned"><Show when={state.pinnedImage.get()} keyed fallback={<p>Open an image and choose Pin.</p>}>{image=><ImageContent image={image} size="full"/>}</Show></div></Show>
    <Show when={state.inspector.get() === 'raw'}><div class="history-raw"><Show when={selected()} keyed fallback={<p>Choose an item's ⟨/⟩ icon.</p>}>{item=><div><strong>{item.label}</strong><dl><dt>ID</dt><dd><code>{item.nativeId || '—'}</code></dd><dt>Path</dt><dd><code>{item.path}</code></dd><dt>Phase</dt><dd>{item.phase || item.messageDisposition || 'Not reported'}</dd><dt>Clock start</dt><dd>{item.timing.startedAtMs===null?'Not reported':new Date(item.timing.startedAtMs).toISOString()}</dd><dt>Clock end</dt><dd>{item.timing.completedAtMs===null?'Not reported':new Date(item.timing.completedAtMs).toISOString()}</dd><dt>Reported</dt><dd>{formatDuration(item.timing.reportedDurationMs)}</dd><dt>Interval</dt><dd>{item.timing.startedAtMs!==null&&item.timing.completedAtMs!==null?formatDuration(item.timing.completedAtMs-item.timing.startedAtMs):'Unknown'}</dd></dl><JsonView value={item.raw} depth={1}/></div>}</Show><details><summary>Complete export envelope</summary><JsonView value={props.projection.document} depth={0}/></details></div></Show>
  </aside>;
}
function Conversation(props: {projection: HistoryProjection}) {
  const entries = () => [...(graph().family.latest()?.lanes.map(lane=>lane.entry)??[]),...(graph().catalog.latest()?.sessions ?? [])];
  const ledger = () => props.projection.ledger, d = () => props.projection.document;
  const ordinal = new Map(props.projection.items.map((item,index)=>[item.id,index]));
  const turns = [...new Set(props.projection.items.flatMap(item=>item.turnId ? [item.turnId] : []))];
  const firstInTurn = new Set(turns.map(turn=>props.projection.items.find(item=>item.turnId===turn)!.id));
  const filter = (value:string) => {state.query.set(value);state.windowStart.set(0);state.focus.set(current=>({id:'',sequence:current.sequence+1}));};
  createEffect(()=>({focus:graph().readerFocus.latest()??state.focus.get(),window:graph().window.latest()}),({focus})=>{
    if(!focus.id)return;
    requestAnimationFrame(()=>{
      const target=document.querySelector<HTMLElement>(`[data-history-item="${CSS.escape(focus.id)}"]`);
      target?.scrollIntoView({block:focus.align??'center',behavior:'instant'});target?.focus({preventScroll:true});
    });
  });
  return <ImageAssets value={props.projection.document.source.assets}><main class="history-conversation" data-density={state.density.get()}><header class="history-conversation-head"><span class="history-source-badge">{d().provider} · {d().provider==='specimen'?'synthetic bench':state.selectedFamilyId.get()?(graph().family.latest()?.groupKind==='collection'?'example capture':'family capture'):d().source.corpus==='everyday'?'real work':'real experiment'}</span><h1 title={d().title}>{d().title}</h1><button title="Source and coverage" onClick={()=>state.inspector.set(state.inspector.get()==='provenance'?'map':'provenance')}>ⓘ</button></header>
    <div class="history-metrics"><span title="Native records in the full capture">{props.projection.items.length.toLocaleString()} items</span><span title="Native input counters; Claude cache read/create are separate">↓ {(ledger().input === null ? '—' : formatCount(ledger().input))}</span><span title="Reported cache-read input tokens">↺ {(ledger().cachedInput === null ? '—' : formatCount(ledger().cachedInput))}</span><span title="Reported cache-creation input tokens">⊕ {(ledger().cacheCreation === null ? '—' : formatCount(ledger().cacheCreation))}</span><span title="Reported output tokens">↑ {(ledger().output === null ? '—' : formatCount(ledger().output))}</span><button title="Cost estimation is not implemented; context occupancy is not established by these native history items" onClick={()=>state.inspector.set('provenance')}>$ — · context —</button><span class="history-metrics-note">{ledger().knownRequests ? `${ledger().knownRequests} responses with counters` : 'usage absent in this source'}</span></div>
    <div class="history-transcript-controls"><input type="search" aria-label="Search transcript" placeholder="Find text, tools or IDs…" data-control={state.query.name} value={state.query.get()} onInput={event=>filter(event.currentTarget.value)}/><ControlSelect of={state.kind} label="Items"/>
      <button title="Find and expand an image in this agent" onClick={()=>findKind.run({kind:'image'})}><Icon kind="image"/></button><button title="Show operation events in this agent" onClick={()=>findKind.run({kind:'event'})}>◇</button><div class="history-density" aria-label="Transcript detail"><For each={['outline','compact','reading']}>{level=><button aria-pressed={state.density.get()===level ? 'true' : 'false'} onClick={()=>state.setDensity.run({level})}>{level}</button>}</For></div><button title="Show navigation minimap" aria-label="Show navigation minimap" onClick={()=>state.inspector.set(state.inspector.get()==='map'?'closed':'map')}><Icon kind="map"/></button></div>
    <CellView of={graph().window} label="Preparing display window" keepLatest={false}>{window=><div class="history-window-controls"><button disabled={window().start===0} onClick={()=>pageWindow.run({direction:'previous'})}>←</button><span>{window().total ? window().start+1 : 0}–{window().end} / {window().total.toLocaleString()} matching</span><button disabled={window().end===window().total} onClick={()=>pageWindow.run({direction:'next'})}>→</button><button title="Expand displayed items" onClick={()=>expandWindow.run({open:true})}>+</button><button title="Fold displayed items" onClick={()=>expandWindow.run({open:false})}>−</button><ControlSelect of={state.windowSize} label="Window"/><label class="history-update-toggle"><input type="checkbox" checked={state.updatesAsPills.get()} data-control={state.updatesAsPills.name} onChange={event=>state.updatesAsPills.set(event.currentTarget.checked)}/> Update pills</label><small title="The whole export is fetched and parsed. This window limits mounted UI, not captured history or network transfer.">Full capture loaded</small></div>}</CellView>
    <CellView of={graph().rows} label="Rendering trace" keepLatest={false}>{rows=><div class="history-transcript" aria-label="Read-only transcript"><For each={rows()}>{row=><div class={`history-row history-row-${row.kind}`}><Show when={row.items[0].turnId && firstInTurn.has(row.items[0].id)}><div class="history-turn"><span>Turn {turns.indexOf(row.items[0].turnId!)+1}</span><button title="Expand this native turn" onClick={()=>expandTurn.run({turnId:row.items[0].turnId,open:true})}>+</button><button title="Fold this native turn" onClick={()=>expandTurn.run({turnId:row.items[0].turnId,open:false})}>−</button></div></Show><For each={row.items}>{item=><span class="history-item-slot"><Item item={item} entries={entries()} ordinal={ordinal.get(item.id) ?? 0}/></span>}</For></div>}</For><Show when={!rows().length}><p class="history-empty">No items match.</p></Show><For each={props.projection.warnings}>{warning=><p class="history-warning">{warning}</p>}</For></div>}</CellView>
  </main><Show when={state.inspector.get()!=='closed'}><Inspector projection={props.projection} entries={entries()}/></Show></ImageAssets>;
}
/** Disposable readers over durable controls; native payloads remain untouched across hot edits. */
export function App() {
  const commands:Command[]=[
    {id:'next',group:'Navigate',label:'Next item',key:'j',icon:'↓',run:()=>stepItem.run({direction:'next'})},
    {id:'previous',group:'Navigate',label:'Previous item',key:'k',icon:'↑',run:()=>stepItem.run({direction:'previous'})},
    {id:'sources',group:'Navigate',label:'Sessions',key:'s',icon:'☷',run:()=>state.toggleSources.run()},
    {id:'map',group:'Navigate',label:'Minimap',key:'m',icon:'▥',run:()=>state.inspector.set('map')},
    {id:'raw',group:'Inspect',label:'Raw inspector',key:'r',icon:'{}',run:()=>state.toggleRaw.run()},
    {id:'provenance',group:'Inspect',label:'Source and coverage',key:'p',icon:'◈',run:()=>state.inspector.set('provenance')},
    ...['outline','compact','reading'].map((level,index)=>({id:level,group:'Detail',label:level,key:String(index+1),icon:['≡','☷','¶'][index],run:()=>state.setDensity.run({level})})),
    {id:'images',group:'Navigate',label:'Find images in this agent',key:'i',icon:'▧',run:()=>findKind.run({kind:'image'})},
    {id:'events',group:'Navigate',label:'Operation events',key:'e',icon:'◇',run:()=>findKind.run({kind:'event'})},
    {id:'axis',group:'Navigate',label:'Sequence / calendar time',key:'t',icon:'◷',run:()=>state.mapAxis.set(state.mapAxis.get()==='time'?'sequence':'time')},
    {id:'updates',group:'Detail',label:'Toggle update pills',key:'u',icon:'⋯',run:()=>state.updatesAsPills.set(!state.updatesAsPills.get())},
    {id:'refresh',group:'Inspect',label:'Refresh local export',key:'f',icon:'↻',run:()=>state.refresh.run()},
  ];
  return <div class="history-app"><header class="history-topbar"><a href="/">hp <span>lab</span></a><strong>History</strong><span class="history-readonly">● read only</span><span class="history-top-explanation" role="status">{latest(()=>graph().familyResult.loading() || graph().document.loading() || !graph().document.settled()) ? '◌ Loading captured history…' : 'Captured conversations'}</span><button onClick={()=>state.toggleSources.run()}>Sessions</button><button title="Reread existing local exports; no provider request" onClick={()=>state.refresh.run()}>↻ Refresh</button><a class="history-notes-link" href="/059-historical-viewer/README.md">Notes ↗</a></header>
    <div class="history-body" style={{'--history-map-width':`${state.mapWidth.get()}px`}} data-sources={state.sourcesOpen.get() ? 'true' : 'false'} data-inspector={state.inspector.get()}><Show when={state.sourcesOpen.get()}><SourceCatalog/></Show>
      <CellView of={graph().projection} label="Reading local history export" keepLatest={false}>{projection=><Show when={projection()} keyed fallback={<main class="history-empty"><h1>Capture unavailable</h1><p role="alert">{graph().document.latest()?.loadError || 'Generate a native history export with spike 058.'}</p><button onClick={()=>state.openHistory.run({key:'@specimen'})}>Synthetic rendering bench</button></main>}>{value=><Conversation projection={value}/>}</Show>}</CellView>
    </div><CommandPalette scope="native-history" commands={commands}/></div>;
}

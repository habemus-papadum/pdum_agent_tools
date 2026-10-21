/** Disposable readers over the scoped store and graph; presentation never owns a second session runtime. */
import {bridgeEffect, CellView} from '@habemus-papadum/aiui-viz';
import {Lens} from '@habemus-papadum/aiui-viz/site/lens';
import {For, Repeat, Show, createMemo, onCleanup, untrack} from 'solid-js';
import {CommandPalette} from '../../../055-orchestrator-mock-lab/shared/CommandPalette';
import {reference,capturedLines} from '../../model.mjs';
import {graph} from '../model/graph';
import * as s from '../model/store';
import {fixtureItems,formatMoney,formatNumber,formatTime, type ProjectionRow, type NavigationPoint} from '../model/telemetry';

function ControlSelect(props:{control:any;label:string;disabled?:boolean}) {
  return <select aria-label={props.label} title={props.label} data-control={props.control.name} value={props.control.get()} disabled={props.disabled} onChange={e=>props.control.set(e.currentTarget.value)}><For each={props.control.meta.options??[]}>{option=><option value={String(option)}>{String(option)}</option>}</For></select>;
}
function SourcePreview(){return <div class="source-preview"><strong>src/retry.ts · atlas.local</strong><pre>{capturedLines.slice(6,12).join('\n')}</pre><small>Captured tool result · read-only</small></div>;}
function SourceViewer(){
  let code:HTMLDivElement|undefined;
  const select=(line:number,extend:boolean)=>{const state=s.session.get();s.selectLines.run({start:extend?(state.anchor??line):line,end:line});};
  const validSelection=()=>{const view=graph().sourceView.latest();return Boolean(view?.available&&s.session.get().selectionKey===`${view.source}|${view.version}`);};
  const isSelected=(line:number)=>{const selection=s.session.get().selection;return Boolean(validSelection()&&selection&&line>=selection[0]&&line<=selection[1]);};
  return <div class="source-panel">
    <div class="source-toolbar"><div class="source-switch"><button data-control={s.source.name} aria-pressed={s.source.get()==='captured'?'true':'false'} onClick={()=>{s.source.set('captured');s.clearSelection.run();}}>Captured</button><button data-control={s.source.name} aria-pressed={s.source.get()==='current'?'true':'false'} onClick={()=>{s.source.set('current');s.clearSelection.run();}}>Current host file</button></div><span class="eyebrow">Read only</span></div>
    <details class="provenance"><summary>atlas.local · /work/projects/relay/src/retry.ts</summary><p>Reference cwd: {reference.cwd}<br/>Captured item: {reference.sourceItemId}<br/>Source: {s.source.get()} · {graph().sourceView.latest()?.version??'unavailable'}</p></details>
    <CellView of={graph().sourceView} label="Reading fixture source">{view=><>
      <Show when={!view().available}><p class="notice error">Current file not found on atlas.local. Choose captured evidence explicitly; there is no local-path fallback.</p></Show>
      <Show when={s.scenario.get()==='changed'}><p class="notice">Current host bytes changed after this tool read. Captured and submitted excerpts retain their earlier version.</p></Show>
      <div id="source-lines" class="source-lines" ref={el=>{code=el;queueMicrotask(()=>{el.scrollTop=s.sourceScrollPosition.get();});}} onScroll={e=>s.sourceScrollPosition.set(e.currentTarget.scrollTop)}>
        <Repeat count={view().lines.length}>{index=><button class="code-line" data-line={index+1} aria-label={`Select line ${index+1}`} aria-pressed={isSelected(index+1)?'true':'false'} onClick={e=>select(index+1,e.shiftKey)} onKeyDown={e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const next=Math.max(1,Math.min(view().lines.length,index+1+(e.key==='ArrowDown'?1:-1)));if(e.shiftKey)select(next,true);code?.querySelector<HTMLButtonElement>(`[data-line="${next}"]`)?.focus();}}}><span class="line-number">{index+1}</span><code>{view().lines[index]||' '}</code></button>}</Repeat>
      </div>
    </>}</CellView>
    <div class="selection-tools"><span>{validSelection()&&s.session.get().selection?`Lines ${s.session.get().selection!.join('–')} · ${s.source.get()}`:'Select a line; shift-click extends.'}</span><button onClick={()=>s.clearSelection.run()}>Clear</button></div>
    <textarea aria-label="Comment on selected code" data-control={s.comment.name} value={s.comment.get()} rows={2} placeholder="Comment on these lines…" onInput={e=>s.comment.set(e.currentTarget.value)}/>
    <div class="source-footer"><span>Local draft comment</span><button disabled={!s.session.get().selection||!validSelection()} onClick={()=>s.addExcerpt.run()}>Add to prompt ↓</button></div>
  </div>;
}
function SourceDetail(){
  const previousScroll=untrack(()=>s.scrollPosition.get());
  onCleanup(()=>queueMicrotask(()=>{const chat=document.querySelector<HTMLElement>('#conversation-scroll');if(chat)chat.scrollTop=previousScroll;}));
  return <><div class="detail-actions"><button onClick={event=>{s.pinSource.run();event.currentTarget.closest('.aiui-lens-panel')?.querySelector<HTMLButtonElement>('.aiui-lens-close')?.click();}}>Pin beside chat →</button></div><SourceViewer/></>;
}

function UsageStrip(props:{row:ProjectionRow}){
  const r=createMemo(()=>props.row), item=createMemo(()=>r().item);
  const tooltip=()=>`${r().attribution}. ${item().usage?`Input ${item().usage!.input.toLocaleString()}, including ${item().usage!.cachedInput.toLocaleString()} cached; output ${item().usage!.output.toLocaleString()}. `:''}Running known request cost ${formatMoney(r().cumulativeCost)}; ${formatNumber(r().cumulativeTokens)} total input+output tokens. Context is a snapshot, not usage. Prices are illustrative, not provider billing.`;
  return <div class={`usage-strip ${item().usage===null?'usage-gap':''}`} title={tooltip()}>
    <Show when={item().requestId} fallback={<Show when={item().kind==='tool'} fallback={<span>context {formatNumber(item().contextBefore??0)} → {formatNumber(item().context??0)} · charge unavailable</span>}><span>{item().parentRequestId} ↗ · {item().duration}s · no separate model charge</span></Show>}>
      <span>{item().requestId}</span><span>{r().cost===null?'cost unavailable':`${formatMoney(r().cost!)}*`}</span><span>{item().usage?`${formatNumber(item().usage!.input)} in / ${formatNumber(item().usage!.output)} out`:'usage unavailable'}</span><Show when={item().usage}><span class="cache-indicator">{Math.round((item().usage?.cachedInput??0)/(item().usage?.input??1)*100)}% cached</span></Show><span>{r().contextKnown?`ctx ${formatNumber(r().context!)}`:'ctx unknown'}</span>
    </Show>
  </div>;
}
function TranscriptItem(props:{row:ProjectionRow}){
  const row=createMemo(()=>props.row),item=createMemo(()=>row().item);
  return <article id={`item-${item().id}`} data-item={item().id} class={`transcript-item ${item().kind} ${item().status??''} ${s.session.get().selectedItem===item().id?'selected-item':''}`}>
    <Show when={item().kind==='tool'} fallback={<><div class="entry-meta"><span>{item().label}</span><time>{formatTime(item().time)}</time><span>turn {item().turn}</span></div><p>{item().text}</p><Show when={item().kind!=='user'}><UsageStrip row={row()}/></Show></>}>
      <details class="tool" open={item().status==='failed'||item().fileReference||item().status==='running'}>
        <summary><span class={`status-icon ${item().status==='failed'?'failed':item().status==='running'?'running':'done'}`}>{item().status==='failed'?'!':item().status==='running'?'◌':'✓'}</span><strong>{item().label}</strong><span class="tool-caption">{formatTime(item().time)} · {item().status}</span></summary>
        <div class="tool-body"><code>{item().command}</code><Show when={item().fileReference}><p>The retry loop is in <span id="source-lens-host"><Lens label="src/retry.ts:7–12" preview={SourcePreview} detail={SourceDetail} panelClass="session-source-detail">src/retry.ts:7–12</Lens></span>.</p></Show><pre>{item().output}</pre><Show when={item().diagnostic}><p class="tool-diagnostic">{item().diagnostic}</p></Show></div>
        <UsageStrip row={row()}/>
      </details>
    </Show>
  </article>;
}
function pointLabel(p:NavigationPoint){return s.metric.get()==='cost'?`${formatMoney(p.value??0)} known cumulative`:s.metric.get()==='tokens'?`${formatNumber(p.value??0)} known cumulative tokens`:s.metric.get()==='context'?p.value===null?'Context unknown':`${formatNumber(p.value)} context tokens`:formatTime(p.value??0);}
function NavigationMark(props:{point:NavigationPoint}){
  const point=createMemo(()=>props.point);
  return <button class={`nav-point ${point().status} ${point().known?'':'incomplete'} ${s.session.get().selectedItem===point().id?'active':''}`} title={`${point().label} · ${pointLabel(point())}${point().known?'':' · incomplete coverage'}`} aria-label={`Navigate to ${point().label}: ${pointLabel(point())}`} onClick={()=>s.navigate.run({itemId:point().id})}><span class="nav-bar" style={{'--value':`${Math.max(.035,point().position)*100}%`}}/><span class="nav-point-label">{point().id}</span></button>;
}
function Navigator(){
  const title=()=>s.metric.get()==='cost'?'Known request cost · cumulative':s.metric.get()==='tokens'?'Input + output tokens · cumulative':s.metric.get()==='context'?'Context occupancy · snapshot':'Elapsed time';
  return <Show when={s.navigator.get()!=='hidden'}><div class={`navigator ${s.navigator.get()==='rail'?'rail':'top'}`} aria-label="Conversation navigator">
    <div class="nav-settings"><ControlSelect control={s.metric} label="Navigator measure"/><ControlSelect control={s.navigator} label="Navigator placement"/><span>{title()}</span></div>
    <CellView of={graph().navigation}>{points=><div class="nav-points" role="group" aria-label={title()}><For each={fixtureItems}>{(item,index)=><NavigationMark point={points()[index()]}/>}</For></div>}</CellView><div class="nav-caption">Time order → <span>Click to inspect · * illustrative prices</span></div>
  </div></Show>;
}
function StatusBar(){return <CellView of={graph().ledger}>{ledger=><div class="session-totals" title="Known request totals only. Cached input is included in input tokens. Tool rows do not add another charge. Compaction cost unavailable; these illustrative prices are not a bill."><span class="status-dot"/><strong>{s.session.get().receipt?.stage==='turn-started'?'Turn 13 · prior usage':s.session.get().receipt?.stage==='not-applied'?'Turn 12 ended':'Turn 12'}</strong><span>{formatMoney(ledger().totals.cost)}* known</span><span>{formatNumber(ledger().totals.tokens)} tokens</span><span>{Math.round(ledger().totals.cacheShare*100)}% input cached</span><span>ctx {formatNumber(ledger().totals.context??0)} / 128k</span><span class="coverage-mark">{ledger().totals.knownRequests}/{ledger().totals.requests} requests · compaction cost ?</span><Show when={s.navigator.get()==='hidden'}><button onClick={()=>s.navigator.set('top')}>Show navigator</button></Show></div>}</CellView>;}
function Receipt(){
  const titles:Record<string,string>={requested:'Requested · awaiting acceptance',queued:'Queued · not yet applied',applied:'Applied to turn 12','turn-started':'Turn 13 started','not-applied':'Not sent · target ended',rejected:'Rejected · no input applied',unknown:'Delivery unknown · inspect before retrying'};
  return <Show when={s.session.get().receipt}>{receipt=><section class={`receipt ${['not-applied','rejected'].includes(receipt().stage)?'error':receipt().stage==='unknown'?'unknown':''}`} aria-label="Submission receipt"><div class="receipt-head"><h3>{titles[receipt().stage]}</h3><span>{receipt().submission.id}</span><Show when={!receipt().terminal}><button onClick={()=>s.advance.run()}>Advance fixture →</button></Show></div><details><summary>Outcome and frozen request</summary><p>{receipt().message}</p><pre>{JSON.stringify(receipt(),null,2)}</pre></details></section>}</Show>;
}
function Composer(){
  const disabled=()=>s.deliveryMode.get()==='none'||(!s.prompt.get().trim()&&s.session.get().excerpts.length===0)||Boolean(s.session.get().receipt);
  return <section id="composer" class="composer" aria-label="Prompt composer"><div class="attachments"><For each={s.session.get().excerpts}>{excerpt=><details class="attachment"><summary>{excerpt.relativePath}:{excerpt.lines.start}–{excerpt.lines.end} · {excerpt.source}</summary><p>{excerpt.host} · {excerpt.resolvedPath} · {excerpt.contentVersion}</p><pre>{excerpt.text}</pre><p>{excerpt.comment}</p><button onClick={()=>s.removeExcerpt.run({id:excerpt.id})}>Remove</button></details>}</For></div>
    <textarea id="prompt" aria-label="Prompt text" data-control={s.prompt.name} value={s.prompt.get()} rows={2} placeholder="Message this agent…" onInput={e=>s.prompt.set(e.currentTarget.value)}/>
    <div class="compose-toolbar"><fieldset class="intent"><legend class="sr-only">Choose delivery timing</legend><label title="Add input at a supported boundary of active turn 12; do not interrupt a tool."><input type="radio" name="mode" checked={s.deliveryMode.get()==='steer'} data-control={s.deliveryMode.name} onChange={()=>s.deliveryMode.set('steer')}/><span>Steer turn 12</span></label><label title="Start separate work after turn 12. This study simulates an application queue."><input type="radio" name="mode" checked={s.deliveryMode.get()==='queue'} data-control={s.deliveryMode.name} onChange={()=>s.deliveryMode.set('queue')}/><span>Queue next turn</span></label></fieldset>
    <Show when={s.deliveryMode.get()==='queue'} fallback={<span class="active-settings" title="Steering never changes active settings">gpt-6 · medium · priority</span>}><div class="settings"><ControlSelect control={s.model} label="Next-turn model"/><ControlSelect control={s.effort} label="Next-turn effort"/><ControlSelect control={s.tier} label="Next-turn service tier"/></div></Show>
    <button class="primary" id="submit" disabled={disabled()} onClick={()=>s.submit.run()}>{s.deliveryMode.get()==='steer'?'Steer ↑':s.deliveryMode.get()==='queue'?'Queue ↑':'Choose timing ↑'}</button></div>
    <div class="compose-context"><span>session-retry-07 · {s.deliveryMode.get()==='steer'?'active turn 12':s.deliveryMode.get()==='queue'?'next turn after 12':'choose an explicit intent'}</span><span id="draft-count">{s.session.get().excerpts.length} excerpts</span></div><Receipt/>
  </section>;
}
export function App(){
  let chat:HTMLDivElement|undefined;
  let seenOpen=untrack(()=>s.session.get().sourceOpenSequence);
  let seenNavigation=untrack(()=>s.session.get().navSequence);
  let seenReset=untrack(()=>s.session.get().resetSequence);
  bridgeEffect(()=>({seq:s.session.get().navSequence,id:s.session.get().selectedItem}),({seq,id})=>{if(seq===seenNavigation)return;seenNavigation=seq;if(!seq||!chat)return;const item=chat.querySelector<HTMLElement>(`#item-${id}`);if(item)chat.scrollTo({top:chat.scrollTop+item.getBoundingClientRect().top-chat.getBoundingClientRect().top-12,behavior:'instant'});},{scope:s.appScope,name:'transcript-navigation'});
  bridgeEffect(()=>s.session.get().sourceOpenSequence,(sequence)=>{if(sequence===seenOpen)return;seenOpen=sequence;if(!sequence)return;queueMicrotask(()=>document.querySelector<HTMLButtonElement>('#source-lens-host .aiui-lens-trigger')?.click());},{scope:s.appScope,name:'source-detail-opening'});
  bridgeEffect(()=>s.session.get().resetSequence,(sequence)=>{if(sequence===seenReset)return;seenReset=sequence;queueMicrotask(()=>{document.querySelector<HTMLButtonElement>('.session-source-detail .aiui-lens-close')?.click();if(chat)chat.scrollTop=0;});},{scope:s.appScope,name:'reset-presentation'});
  const commands=[
    {id:'source',group:'Source',label:'Open source detail',key:'f',icon:'↗',run:()=>{s.openSource.run();}},
    {id:'pin',group:'Source',label:'Pin source beside chat',key:'p',icon:'⌖',run:()=>{s.pinSource.run();}},
    {id:'close-source',group:'Source',label:'Close pinned source',key:'x',icon:'×',run:()=>{s.closeSource.run();}},
    {id:'failure',group:'Navigate',label:'Jump to failed command',key:'e',icon:'!',run:()=>{s.navigate.run({itemId:'t3'});}},
    {id:'expensive',group:'Navigate',label:'Jump to expensive request',key:'c',icon:'$',run:()=>{s.navigate.run({itemId:'m4'});}},
    {id:'compact',group:'Navigate',label:'Jump to compaction',key:'k',icon:'↘',run:()=>{s.navigate.run({itemId:'compact1'});}},
    {id:'latest',group:'Navigate',label:'Jump to latest tool',key:'j',icon:'↓',run:()=>{s.navigate.run({itemId:'t7'});}},
  ];
  return <div class="session-app">
    <header class="app-header"><a class="back" href="/053-orchestrator-overview/">← Agents</a><h1>Retry cancellation</h1><span class="header-identity">Codex · atlas</span><span class="keyboard-hint">Space · commands</span><details class="session-info"><summary title="Session identity">Session ▾</summary><div class="compact-popover"><p>session-retry-07<br/>Profile: engineering<br/>Host: atlas.local</p><code>/work/projects/relay</code><p>All content and telemetry is fixture data.</p></div></details><details class="mock-tools"><summary>Study ⚙</summary><div class="compact-popover"><p class="eyebrow">Interaction study 02</p><p>No real agent or file operation. All telemetry and prices are illustrative.</p><label>Outcome</label><ControlSelect control={s.scenario} label="Fixture outcome" disabled={Boolean(s.session.get().receipt)}/><label>Usage evidence</label><ControlSelect control={s.usageCoverage} label="Usage evidence coverage"/><label>Navigator</label><ControlSelect control={s.navigator} label="Navigator placement"/><p>Model request rows own usage. Tool rows link to the request; context snapshots are never added to token totals.</p><button onClick={()=>s.reset.run()}>Reset study</button><a href="./README.md">Design intent ↗</a></div></details></header>
    <main class="workspace"><section class="conversation-column"><StatusBar/><Show when={s.navigator.get()==='top'}><Navigator/></Show><div class="conversation-with-rail"><Show when={s.navigator.get()==='rail'}><Navigator/></Show><div class="conversation-scroll" id="conversation-scroll" ref={el=>{chat=el;queueMicrotask(()=>{el.scrollTop=s.scrollPosition.get();});}} onScroll={e=>s.scrollPosition.set(e.currentTarget.scrollTop)}><div class="timeline"><CellView of={graph().ledger}>{ledger=><For each={fixtureItems}>{(item,index)=><TranscriptItem row={ledger().rows[index()]}/>}</For>}</CellView></div></div></div><Composer/></section>
      <Show when={s.session.get().pinned}><aside class="pinned-source" id="pinned-source"><div class="lens-head"><strong>src/retry.ts</strong><span class="eyebrow">Pinned</span><button onClick={()=>{s.closeSource.run();s.openSource.run();}}>Unpin ↗</button><button aria-label="Close source pane" onClick={()=>s.closeSource.run()}>×</button></div><SourceViewer/></aside></Show>
    </main><CommandPalette scope={s.appScope.name} commands={commands}/>
  </div>;
}

import {createMemo, createSignal, For, Show} from 'solid-js';
import {CellView, ControlSelect} from '@habemus-papadum/aiui-viz';
import {graph,openFamily,openActor,openExample,chooseLane,jumpMap,jumpIndex,findKind} from '../model/graph';
import * as state from '../model/store';
import type {FamilyLane} from '../model/family';
import {formatCount,object} from '../model/native';
import {formatDuration} from '../model/presentation';
import {forwardTime,inverseTime,timeExtent} from '../model/timeline';
import {Icon} from './Icons';
import {modelColorIndex} from '../model/map-metrics';
import {exampleBookmarks} from '../model/examples';

export function actorLabel(lane:FamilyLane,all:readonly FamilyLane[]):string {
  if(lane.displayLabel)return lane.displayLabel;
  if(lane.parentStatus==='root')return 'Main';
  const path=object(object(lane.projection.document.payload).thread).agentPath;
  if(typeof path==='string'&&path.split('/').filter(Boolean).length>1)return path.split('/').at(-1)!;
  return `Agent ${Math.max(1,all.filter(value=>value.parentStatus!=='root').findIndex(value=>value.key===lane.key)+1)}`;
}
const clock=(ms:number|null)=>ms===null?'No clock':new Date(ms).toISOString().slice(0,16).replace('T',' ')+'Z';
const count=(n:number|null)=>n===null?'—':formatCount(n);

export function FamilyChooser(){
  return <div class="history-family-chooser"><span class="history-eyebrow">Families & examples</span>
    <CellView of={graph().families} label="Reading family catalogue">{index=><>
      <select aria-label="Captured family" value={state.selectedFamilyId.get()} onChange={event=>event.currentTarget.value?openFamily.run({id:event.currentTarget.value}):state.leaveFamily.run()}>
        <option value="">Individual captures</option><For each={index().families}>{family=><option value={family.id} disabled={!family.available}>{family.title}{family.available?'':' · unavailable'}</option>}</For>
      </select><Show when={index().loadError}><small>Family exports unavailable · <a href="/docs/spikes/059-agent-family-evidence.md">collection notes</a></small></Show>
    </>}</CellView>
  </div>;
}
function ActorRow(props:{lane:FamilyLane;all:FamilyLane[];collection?:boolean}){
  const lane=props.lane;
  const selected=createMemo(()=>graph().projection.latest()?.document.key===lane.key);
  const visible=createMemo(()=>state.selectedLanes.get()?.includes(lane.key)??true);
  const depth=()=>{let n=0,key=lane.parentKey;while(key&&n<4){n++;key=props.all.find(value=>value.key===key)?.parentKey??null;}return n;};
  return <div class="history-actor-row" data-selected={selected()?'true':'false'} style={{'--actor-depth':depth()}}>
    <input type="checkbox" aria-label={`Show ${actorLabel(lane,props.all)} on map`} checked={visible()} onChange={()=>chooseLane.run({key:lane.key})}/>
    <button class="history-actor-name" title={`${lane.entry.title}\nParent: ${lane.parentStatus} · ${lane.parentBasis}`} onClick={()=>openActor.run({key:lane.key})}>
      <span><Icon kind={props.collection?'file':'agent'}/><b>{actorLabel(lane,props.all)}</b><Show when={!props.collection&&(lane.parentStatus==='unknown'||lane.parentStatus==='missing'||lane.parentStatus==='ambiguous')}><i title="Parent identity is not established">?</i></Show></span>
      <small>{lane.stats.items.toLocaleString()} items · <span class={lane.stats.reportedErrors?'has-errors':''}>{lane.stats.reportedErrors} errors</span><Show when={lane.stats.images}> · ▧ {lane.stats.images}</Show></small>
    </button><button class="history-actor-only" title="Show only this lane on the map" onClick={()=>chooseLane.run({key:lane.key,mode:'only'})}>only</button>
  </div>;
}
function ExampleBookmarks(){
  const bundle=()=>graph().familyResult.latest()?.bundle;
  const points=()=>exampleBookmarks(bundle()?.bookmarks??object(bundle()?.relationships).bookmarks);
  const current=createMemo(()=>graph().projection.latest()?.items.find(item=>item.id===graph().readerFocus.latest()?.id));
  const gaps=()=>{const value=object(object(bundle()?.relationships).coverage).gaps;return Array.isArray(value)?value:[];};
  return <section class="history-examples" aria-label="Qualified message examples"><h2>Jump to a real message</h2><p>Independent captures, grouped for review.</p>
    <For each={points()} keyed={point=>point.id}>{point=><div class="history-example-row">
      <button data-example={point().id} data-selected={graph().projection.latest()?.document.key===point().documentKey&&current()?.nativeId===(point().itemId||point().uuid)?'true':'false'} onClick={()=>openExample.run({id:point().id})}>
        <Icon kind={point().features.includes('image')?'image':'math'}/><span>{point().label}</span>
      </button><a title="Open this example directly" aria-label={`Direct link: ${point().label}`} href={`/history/?group=rich-messages&example=${encodeURIComponent(point().id)}`}>↗</a>
    </div>}</For>
    <Show when={state.exampleNotice.get() || (graph().initialExample.latest()?.available===false ? (graph().initialExample.latest() as any).reason : '')}><p class="history-warning" role="alert">{state.exampleNotice.get() || (graph().initialExample.latest() as any)?.reason}</p></Show>
    <details class="history-example-gaps"><summary>Examples still missing ({gaps().length})</summary><For each={gaps()}>{gap=><p>{String(object(gap).reason??'Not yet qualified')}</p>}</For></details>
  </section>;
}
export function FamilyMembers(){
  return <CellView of={graph().family} label="Loading captured family…" keepLatest={false}>{family=><Show when={family()} keyed fallback={<p class="history-empty">{graph().familyResult.latest()?.loadError||'No family loaded'}</p>}>{value=><div class="history-family-members">
    <Show when={value.groupKind==='collection'}><ExampleBookmarks/></Show>
    <div class="history-family-meta"><span>{value.lanes.length} {value.groupKind==='collection'?'captures':'agents'} · {value.stats.items.toLocaleString()} items</span><button onClick={()=>chooseLane.run({mode:'all'})}>All lanes</button></div>
    <For each={value.lanes}>{lane=><ActorRow lane={lane} all={value.lanes} collection={value.groupKind==='collection'}/>}</For>
    <div class="history-family-notes"><small>{value.groupKind==='collection'?'This collection asserts no parent/child relationships.':'Completion marks work completed, not shutdown.'}</small>
      <Show when={value.groupKind!=='collection'&&value.lanes.some(lane=>['unknown','missing','ambiguous'].includes(lane.parentStatus))}><small>? {value.lanes.filter(lane=>['unknown','missing','ambiguous'].includes(lane.parentStatus)).length} parent relationships are not established by this capture.</small></Show>
      <Show when={value.ledger.sharedResponses}><small>{value.ledger.sharedResponses} response IDs occur in several agents. Family totals deduplicate; ownership is unassigned.</small></Show>
      <Show when={value.warnings.length||value.missingMembers.length}><details><summary>Coverage notes</summary><For each={value.warnings}>{warning=><p>{warning}</p>}</For><For each={value.missingMembers}>{member=><p>{member.reason}</p>}</For></details></Show>
      <a href="/docs/spikes/059-data-availability.md">Data availability ledger ↗</a>
    </div>
  </div>}</Show>}</CellView>;
}

const trackMeaning:Record<string,string>={
  activity:'User, assistant and work records. A completed child may work again.',
  errors:'Explicit error records, including qualified notices. A failed search is not automatically an unhealthy agent.',
  duration:'Largest reported elapsed value in each bin, on a log width scale. Includes intentional waits; not CPU time or summed wall time.',
  tokens:'Known response counters, once per lane at the first recorded occurrence. Shared responses can appear in several lanes; family totals deduplicate.',
  model:'Model reported for this actor response. Child-creation settings never color the parent response.',
  cost:'Cost estimation is not implemented for these native captures.',
  context:'Current context occupancy is not established by these history fields.',
};
/** Disposable geometry readers preserve actor and time controls across UI hot edits. */
export function FamilyMap(){
  const lanes=()=>graph().lanes.latest()??[];
  const axis=()=>graph().timeAxis.latest();
  const rows=()=>graph().navigation.latest()??[];
  const metrics=()=>graph().metrics.latest();
  const [hover,setHover]=createSignal('');
  const isTime=()=>state.mapAxis.get()==='time';
  const known=()=>state.mapTrack.get()==='activity'?rows().reduce((sum,row)=>sum+row.positionedItems,0):metrics()?.series.reduce((sum,row)=>sum+row.positioned,0)??0;
  const fullWidth=()=>Math.max(100,lanes().length*100);
  const visualWidth=()=>Math.max(state.mapWidth.get()-30,lanes().length*32);
  const paths=(key:string)=>state.mapTrack.get()==='activity'?rows().find(row=>row.key===key)?.paths??[]:metrics()?.series.find(row=>row.key===key)?.paths??[];
  const selection=createMemo(()=>{
    const selected=graph().projection.latest(),window=graph().window.latest(),values=lanes(),index=values.findIndex(lane=>lane.key===selected?.document.key);
    if(index<0||!selected||!window?.items.length)return null;
    const lane=values[index],positions:number[]=[];
    for(const item of window.items){
      if(isTime()){const extent=timeExtent(item);if(extent&&axis()){const start=forwardTime(axis()!,extent.startMs),end=forwardTime(axis()!,extent.endMs);if(start!==null&&end!==null)positions.push(start,end);}}
      else {const at=lane.items.indexOf(item);if(at>=0)positions.push(lane.items.length>1?at/(lane.items.length-1):0);}
    }
    return positions.length?{index,start:Math.min(...positions),end:Math.max(...positions)}:null;
  });
  const choose=(event:MouseEvent&{currentTarget:SVGSVGElement},jump:boolean)=>{
    const bounds=event.currentTarget.getBoundingClientRect(),x=(event.clientX-bounds.left)/bounds.width,y=Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height));
    const lane=lanes()[Math.min(lanes().length-1,Math.max(0,Math.floor(x*lanes().length)))];if(!lane)return;
    const at=isTime()&&axis()?clock(inverseTime(axis()!,y)):`${Math.round(y*100)}% of this agent's item order`;
    setHover(`${actorLabel(lane,graph().allLanes.latest()??[])} · ${at}`);
    if(jump)jumpMap.run({key:lane.key,position:y});
  };
  return <div class="history-family-map">
    <div class="history-map-settings"><ControlSelect of={state.mapAxis} label="Axis"/><ControlSelect of={state.mapTrack} label="Track"/><ControlSelect of={state.mapWidth} label="Width"/></div>
    <Show when={isTime()}><div class="history-gap-controls"><label><input type="checkbox" checked={state.compressGaps.get()} data-control={state.compressGaps.name} onChange={event=>state.compressGaps.set(event.currentTarget.checked)}/> Fold gaps</label><ControlSelect of={state.gapMinutes} label="Minutes"/></div></Show>
    <div class="history-map-caption" title={trackMeaning[state.mapTrack.get()]}><span>{lanes().length} / {graph().allLanes.latest()?.length??0} lanes · {known().toLocaleString()} positioned</span><span>{isTime()?'Shared time · UTC':'Relative item order in each agent'}</span></div>
    <Show when={state.selectedFamilyId.get()&&(graph().selectedUsage.latest()?.knownRequests??0)>0}><div class="history-family-usage" title="Selected lanes: known response counters, deduplicated by provider and response ID. Shared response ownership is unassigned; missing requests remain unknown.">↓ {count(graph().selectedUsage.latest()?.input??null)} · ↺ {count(graph().selectedUsage.latest()?.cachedInput??null)} · ↑ {count(graph().selectedUsage.latest()?.output??null)}<Show when={graph().selectedUsage.latest()?.sharedResponses}> · {graph().selectedUsage.latest()?.sharedResponses} shared</Show></div></Show>
    <Show when={isTime()&&axis()?.minMs!==null}><div class="history-clock-range"><span>{clock(axis()?.minMs??null)}</span><span>{formatDuration(axis()?.rawDurationMs??null)} span</span></div></Show>
    <Show when={lanes().length} fallback={<p class="history-map-empty">No lanes selected. Choose an agent or All lanes.</p>}>
      <div class="history-lane-scroll"><div class="history-lane-canvas" style={{width:`${visualWidth()}px`}}>
        <div class="history-lane-heads"><For each={lanes()} keyed={lane=>lane.key}>{lane=><button title={actorLabel(lane(),graph().allLanes.latest()??[])} data-selected={graph().projection.latest()?.document.key===lane().key?'true':'false'} onClick={()=>openActor.run({key:lane().key})}>{graph().family.latest()?.groupKind==='collection'?`E${(graph().allLanes.latest()??[]).indexOf(lane())+1}`:lane().parentStatus==='root'?'M':`A${(graph().allLanes.latest()??[]).indexOf(lane())}`}</button>}</For></div>
        <div class="history-map-plot">
          <svg class="history-map-svg" viewBox={`0 0 ${fullWidth()} 600`} preserveAspectRatio="none" aria-label="Agent family navigator" onClick={event=>choose(event,true)} onMouseMove={event=>choose(event,false)} onMouseLeave={()=>setHover('')}>
            <defs><pattern id="history-time-gap" width="18" height="6" patternUnits="userSpaceOnUse"><path d="M0 6L18 0" class="history-gap-stripe"/></pattern></defs>
            <For each={lanes()} keyed={lane=>lane.key}>{lane=><g transform={`translate(${lanes().indexOf(lane())*100},0)`}>
              <rect class="history-lane-ground" x="1" y="0" width="98" height="600"/>
              <For each={paths(lane().key)} keyed={path=>path.kind}>{path=><path class={path().kind} d={path().path}/>}</For>
            </g>}</For>
            <Show when={isTime()}><For each={axis()?.gaps??[]} keyed={gap=>gap.id}>{gap=><g class="history-gap-mark" onClick={event=>{event.stopPropagation();state.toggleGap.run({id:gap().id});}}>
              <title>{`${formatDuration(gap().elapsedMs)} with no recorded activity in selected lanes · ${gap().compressed?'click to expand':'click to fold'}`}</title>
              <rect x="0" y={gap().start*600} width={fullWidth()} height={Math.max(3,(gap().end-gap().start)*600)} fill={gap().compressed?'url(#history-time-gap)':'transparent'}/>
              <path d={`M0 ${gap().start*600}H${fullWidth()}`} class="history-gap-line"/>
            </g>}</For></Show>
            <Show when={selection()}>{value=><rect class="history-map-window" x={value().index*100+1} width="98" y={value().start*600} height={Math.max(3,(value().end-value().start)*600)}/>}</Show>
          </svg>
          <Show when={isTime()}><div class="history-gap-labels"><For each={(axis()?.gaps??[]).filter(gap=>gap.end-gap.start>.015)} keyed={gap=>gap.id}>{gap=><span style={{top:`${(gap().start+gap().end)*50}%`}}>{formatDuration(gap().elapsedMs)} {gap().compressed?'folded':'gap'}</span>}</For></div></Show>
          <Show when={!known()}><div class="history-map-empty-overlay"><strong>{isTime()&&!axis()?.knownItems?'No item clocks':`No ${state.mapTrack.get()} values`}</strong><small>{isTime()&&!axis()?.knownItems?'Use sequence order for this capture.':trackMeaning[state.mapTrack.get()]}</small></div></Show>
        </div>
      </div></div>
    </Show>
    <div class="history-map-readout">{hover()||trackMeaning[state.mapTrack.get()]}</div>
    <Show when={isTime()&&axis()?.maxMs!==null}><small>{clock(axis()?.maxMs??null)}</small></Show>
    <Show when={isTime()&&(axis()?.unknownItems??0)>0}><div class="history-untimed"><b>{axis()?.unknownItems.toLocaleString()} items without clocks</b><button onClick={()=>state.mapAxis.set('sequence')}>Use sequence</button></div></Show>
    <Show when={isTime()&&(axis()?.gaps.length??0)>0}><details class="history-gap-list"><summary>{axis()?.gaps.filter(gap=>gap.compressed).length} gaps folded · inspect elapsed time</summary><For each={axis()?.gaps??[]} keyed={gap=>gap.id}>{gap=><button onClick={()=>state.toggleGap.run({id:gap().id})}>{clock(gap().startMs).slice(5)} · {formatDuration(gap().elapsedMs)} · {gap().compressed?'expand':'fold'}</button>}</For><small>Gaps use all records in selected lanes, before item filtering. Missing observations are not proof of inactivity.</small></details></Show>
    <Show when={state.mapTrack.get()==='duration'||state.mapTrack.get()==='tokens'}><small>Log width · max {state.mapTrack.get()==='duration'?formatDuration(metrics()?.maximum??null):count(metrics()?.maximum??null)}</small></Show>
    <Show when={state.mapTrack.get()==='model'}><div class="history-model-legend"><For each={metrics()?.models??[]}>{(model)=><span class={`model-color-${modelColorIndex(model)}`}>{model}</span>}</For><small>Only this actor's reported response model.</small></div></Show>
    <div class="history-map-jump"><button onClick={()=>graph().visible.latest()?.length&&jumpIndex.run({index:0})}>Start</button><small>Selected agent</small><button onClick={()=>graph().visible.latest()?.length&&jumpIndex.run({index:graph().visible.latest()!.length-1})}>End</button></div>
    <div class="history-family-map-footer"><button onClick={()=>findKind.run({kind:'image'})}>▧ Find images</button><button onClick={()=>findKind.run({kind:'event'})}>◇ Events</button><span title="Duration, tokens, cost and context use different evidence. Missing data stays unknown."><a href="/docs/spikes/059-data-availability.md">Data ↗</a></span></div>
  </div>;
}

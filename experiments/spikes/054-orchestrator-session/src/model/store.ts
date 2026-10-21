/** Durable control/state frontier. UI, keyboard and tools dispatch these same actions. */
import {action, control, scope} from '@habemus-papadum/aiui-viz';
import {fileView, makeExcerpt, makeSubmission, initialReceipt, advanceReceipt} from '../../model.mjs';
import {fixtureItems, type Metric} from './telemetry';
export const appScope=scope('orchestrator-session');
/** Measure shown by the transcript navigator. Cost/tokens are known request totals; context is a snapshot. */
export const metric=control<Metric>({scope:appScope,value:'cost',options:['time','cost','tokens','context']});
/** Compare a small top chart with a side rail; neither changes the transcript or its data. */
export const navigator=control({scope:appScope,value:'top',options:['top','rail','hidden']});
/** Fixture coverage: partial deliberately omits one model request's usage. */
export const usageCoverage=control({scope:appScope,value:'partial',options:['partial','complete']});
/** Explicit prompt delivery. None disables submission; no intent is inferred from text. */
export const deliveryMode=control({scope:appScope,value:'none',options:['none','steer','queue']});
/** Read captured bytes or current fixture bytes; the source is always atlas.local. */
export const source=control({scope:appScope,value:'captured',options:['captured','current']});
/** The scripted delivery/source outcome, changed only through the study controls. */
export const scenario=control({scope:appScope,value:'normal',options:['normal','changed','missing','turn-ended','rejected','unknown']});
/** Model used only when a queued next turn begins. Steering retains the active settings. */
export const model=control({scope:appScope,value:'gpt-6',options:['gpt-6','gpt-6-luna']});
/** Effort used only by the queued turn. */
export const effort=control({scope:appScope,value:'medium',options:['low','medium','high']});
/** Service tier used only by the queued turn. */
export const tier=control({scope:appScope,value:'priority',options:['priority','default']});
/** Draft prompt text. Editing it never changes a frozen request. */
export const prompt=control({scope:appScope,value:''});
/** Comment attached to the next selected source excerpt. */
export const comment=control({scope:appScope,value:''});
export interface SessionState {selection:[number,number]|null;selectionKey:string|null;anchor:number|null;excerpts:any[];receipt:any|null;nextId:number;pinned:boolean;selectedItem:string;navSequence:number;sourceOpenSequence:number;resetSequence:number;}
const initialState=():SessionState=>({selection:null,selectionKey:null,anchor:null,excerpts:[],receipt:null,nextId:1,pinned:false,selectedItem:'m1',navSequence:0,sourceOpenSequence:0,resetSequence:0});
export const session=appScope.durableSignal<SessionState>('session',initialState());
export const scrollPosition=appScope.durableSignal('conversation-scroll',0);
export const sourceScrollPosition=appScope.durableSignal('source-scroll',0);

/** Navigate to an existing transcript item without changing conversation work.
 * @usage Use ids from the session reporter or the timeline. This scrolls the view only.
 * @example {"itemId":"t3"}
 */
export const navigate=action({scope:appScope,name:'navigate',group:'navigation',params:{itemId:'Transcript item id'},run:args=>{
  const id=String(args?.itemId??'');if(!fixtureItems.some(i=>i.id===id))throw new Error('Unknown transcript item');
  return session.set(s=>({...s,selectedItem:id,navSequence:s.navSequence+1}));
}});
/** Pin source beside the transcript, retaining selection, comments and draft. */
export const pinSource=action({scope:appScope,name:'pin-source',group:'source',run:()=>session.set(s=>({...s,pinned:true}))});
/** Close the pinned source view; do not clear its state. */
export const closeSource=action({scope:appScope,name:'close-source',group:'source',run:()=>session.set(s=>({...s,pinned:false}))});
/** Show source detail through its real Lens trigger; no file access occurs. */
export const openSource=action({scope:appScope,name:'open-source',group:'source',run:()=>session.set(s=>({...s,sourceOpenSequence:s.sourceOpenSequence+1}))});
/** Select a closed interval of lines in the chosen source version.
 * @example {"start":7,"end":12}
 */
export const selectLines=action({scope:appScope,name:'select-lines',group:'source',params:{start:'First line (1-based)',end:'Last line (1-based)'},run:args=>{
  const start=Number(args?.start),end=Number(args?.end??start),view=fileView(source.get(),scenario.get());
  if(!view.available||!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<1||start>view.lines.length||end>view.lines.length)throw new Error('Selection outside available source');
  return session.set(s=>({...s,selection:[Math.min(start,end),Math.max(start,end)],selectionKey:`${view.source}|${view.version}`,anchor:start}));
}});
/** Clear source selection while keeping comments and existing prompt excerpts. */
export const clearSelection=action({scope:appScope,name:'clear-selection',group:'source',run:()=>session.set(s=>({...s,selection:null,selectionKey:null,anchor:null}))});
/** Snapshot selected source text, comment and provenance into the prompt draft. */
export const addExcerpt=action({scope:appScope,name:'add-excerpt',group:'draft',run:()=>{
  const current=session.get(),view=fileView(source.get(),scenario.get());
  if(current.selectionKey!==`${view.source}|${view.version}`)throw new Error('Source changed; select lines from the current view before adding an excerpt');
  const excerpt=makeExcerpt(view,current.selection,comment.get(),`excerpt-${current.nextId}`);
  comment.set('');return session.set(s=>({...s,nextId:s.nextId+1,excerpts:[...s.excerpts,excerpt]}));
}});
/** Remove an excerpt from the editable draft; submitted snapshots remain unchanged. */
export const removeExcerpt=action({scope:appScope,name:'remove-excerpt',group:'draft',params:{id:'Excerpt id'},run:args=>session.set(s=>({...s,excerpts:s.excerpts.filter(e=>e.id!==args?.id)}))});
/** Freeze and submit the draft to the explicitly selected fixture target. No real provider call. */
export const submit=action({scope:appScope,name:'submit',group:'conversation',run:()=>{
  const current=session.get();if(current.receipt)throw new Error('Reset this fixture before another submission');
  const submission=makeSubmission({mode:deliveryMode.get(),text:prompt.get(),excerpts:current.excerpts,settings:{model:model.get(),effort:effort.get(),tier:tier.get()},scenario:scenario.get(),id:`request-${current.nextId}`});
  return session.set(s=>({...s,nextId:s.nextId+1,receipt:initialReceipt(submission)}));
}});
/** Advance one scripted receipt stage; never retry or redirect an ambiguous request. */
export const advance=action({scope:appScope,name:'advance-receipt',group:'study',run:()=>session.set(s=>({...s,receipt:s.receipt?advanceReceipt(s.receipt):null}))});
/** Reset all local fixture controls, draft, source selection and receipts. */
export const reset=action({scope:appScope,name:'reset',group:'study',run:()=>{
  metric.set('cost');navigator.set('top');usageCoverage.set('partial');deliveryMode.set('none');source.set('captured');scenario.set('normal');model.set('gpt-6');effort.set('medium');tier.set('priority');prompt.set('');comment.set('');scrollPosition.set(0);sourceScrollPosition.set(0);return session.set(s=>({...initialState(),resetSequence:s.resetSequence+1}));
}});

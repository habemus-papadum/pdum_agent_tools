/** Thin inspection seam; all mutations run registered actions/controls. No second runtime. */
import {flush} from 'solid-js';
import * as s from './model/store';
import {graph} from './model/graph';
function run(action:any,args?:Record<string,unknown>){let result:unknown;flush(()=>{result=action.run(args);});return result;}
function set(control:any,value:unknown){flush(()=>control.set(value));}
function closeDetail(){document.querySelector<HTMLButtonElement>('.session-source-detail .aiui-lens-close')?.click();}
Object.assign(window,{mockSession:{
  get state(){return structuredClone({...s.session.get(),prompt:s.prompt.get(),comment:s.comment.get(),mode:s.deliveryMode.get(),source:s.source.get(),scenario:s.scenario.get(),lens:document.querySelector('.session-source-detail')?'open':s.session.get().pinned?'pinned':document.querySelector('.aiui-lens-peek')?'peek':'closed'});},
  get telemetry(){return graph().ledger.latest();},
  reset(){closeDetail();return run(s.reset);},
  selectLine(line:number,extend=false){const current=s.session.get();return run(s.selectLines,{start:extend?(current.anchor??line):line,end:line});},
  setSource(value:string){run(s.clearSelection);set(s.source,value);},
  setScenario(value:string){set(s.scenario,value);},setPrompt:(value:string)=>set(s.prompt,value),setComment:(value:string)=>set(s.comment,value),setMode:(value:string)=>set(s.deliveryMode,value),
  addExcerpt:()=>run(s.addExcerpt),submit:()=>run(s.submit),advance:()=>run(s.advance),
  openLens:()=>run(s.openSource),pinLens(){closeDetail();return run(s.pinSource);},unpinLens(){run(s.closeSource);return run(s.openSource);},closeLens(){closeDetail();return run(s.closeSource);},
  navigate:(itemId:string)=>run(s.navigate,{itemId}),setMetric:(value:string)=>set(s.metric,value),setNavigator:(value:string)=>set(s.navigator,value),setCoverage:(value:string)=>set(s.usageCoverage,value),
}});

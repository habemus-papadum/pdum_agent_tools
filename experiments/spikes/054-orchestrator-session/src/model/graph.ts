/** Disposable scoped projections over durable UI controls. Graph HMR retains draft state; no provider or network state. */
import {agentToolkit, cell, hotCellGraph, registerStandardTools} from '@habemus-papadum/aiui-viz';
import {fileView} from '../../model.mjs';
import {fixture,projectTelemetry,navigationPoints} from './telemetry';
import {appScope,usageCoverage,metric,navigator,source,scenario,session,prompt} from './store';
export const graph=hotCellGraph(appScope.name,()=>{
  /** Request-level accounting and item attribution, including explicit incomplete coverage. */
  const ledger=cell(()=>({coverage:usageCoverage.get()}),({coverage})=>projectTelemetry(fixture(coverage as 'partial'|'complete')),{scope:appScope});
  /** Chosen navigator measure. Context snapshots may fall while cumulative usage cannot. */
  const navigation=cell(()=>({ledger:ledger(),metric:metric.get()}),({ledger,metric})=>navigationPoints(ledger,metric),{scope:appScope});
  /** Source lookup boundary, reacting to chosen version and missing/changed fixture outcomes. */
  const sourceView=cell(()=>({source:source.get(),scenario:scenario.get()}),({source,scenario})=>fileView(source,scenario),{scope:appScope});
  return {ledger,navigation,sourceView};
},import.meta.hot);
// Vite's static module analysis needs a literal call at this module boundary.
// hotCellGraph still owns dispose/rebuild; this makes the boundary discoverable.
if(import.meta.hot) import.meta.hot.accept();
export type SessionGraph=ReturnType<typeof graph>;
export const kit=agentToolkit(appScope.name,{brief:'A disposable orchestrator session study. All messages and telemetry are fixtures. Model usage is counted once per request; tools are attributed to their parent request and have no independent bill. Use report, set and named actions to navigate, inspect source, compose explicit prompt intent and simulate receipts. No real agent, command, file or provider call runs.'});
registerStandardTools(kit);
kit.registerReporter('session',()=>{
  const state=session.get(),ledger=graph().ledger.latest(),selected=ledger?.rows.find(row=>row.item.id===state.selectedItem);
  return {
    fixture:true,sessionId:'session-retry-07',telemetry:ledger?.totals,
    navigation:{metric:metric.get(),placement:navigator.get(),selectedItem:state.selectedItem},
    selected:selected?{id:selected.item.id,cost:selected.cost,context:selected.context,contextKnown:selected.contextKnown,attribution:selected.attribution}:null,
    draft:{characters:prompt.get().length,excerpts:state.excerpts.length},source:{mode:source.get(),selection:state.selection,pinned:state.pinned},
    receipt:state.receipt?{id:state.receipt.submission.id,stage:state.receipt.stage,mode:state.receipt.submission.mode}:null,
    items:ledger?.rows.map(({item})=>({id:item.id,kind:item.kind,time:item.time,label:item.label,status:item.status})),
  };
});

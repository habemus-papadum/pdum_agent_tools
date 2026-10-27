import {agentToolkit,cell,hotCellGraph,registerStandardTools} from '@habemus-papadum/aiui-viz';
import {appScope,revision,selected,provider,search,sort,view,question,term,request} from './store';
import {selectRows,sessionKey,totals,type Snapshot,type Configuration,type Job,type QuestionResult,type Detail} from './data';
export function createCells(){
 const snapshot=cell(()=>revision.get(),async (_value,ctx):Promise<Snapshot>=>request<Snapshot>('snapshot',{signal:ctx.signal}),{scope:appScope});
 const config=cell(()=>revision.get(),async (_value,ctx):Promise<Configuration>=>request<Configuration>('config',{signal:ctx.signal}),{scope:appScope});
 const status=cell(()=>revision.get(),async (_value,ctx):Promise<{job:Job|null}>=>request<{job:Job|null}>('status',{signal:ctx.signal}),{scope:appScope});
 const rows=cell(()=>({data:snapshot(),provider:provider.get(),search:search.get(),sort:sort.get()}),
  ({data,provider,search,sort})=>selectRows(data.sessions??[],provider,search,sort),{scope:appScope});
 const allTotals=cell(()=>snapshot(),data=>totals(data.sessions??[]),{scope:appScope});
 const filteredTotals=cell(()=>rows(),rows=>totals(rows),{scope:appScope});
 const current=cell(()=>({rows:snapshot().sessions??[],key:selected.get()}),({rows,key})=>rows.find(row=>sessionKey(row)===key)??rows[0]??null,{scope:appScope});
 const detail=cell(()=>({row:current(),revision:revision.get()}),async({row},ctx):Promise<Detail|null>=>row?request<Detail>(`detail?source=${encodeURIComponent(row.source_id)}&thread=${encodeURIComponent(row.thread_id)}`,{signal:ctx.signal}):null,{scope:appScope});
 const analysis=cell(()=>({active:view.get()==='analysis',question:question.get(),term:term.get(),revision:revision.get()}),
  async({active,question,term},ctx):Promise<QuestionResult|null>=>active?request<QuestionResult>(`question?id=${encodeURIComponent(question)}&term=${encodeURIComponent(term)}`,{signal:ctx.signal}):null,{scope:appScope});
 return {snapshot,config,status,rows,allTotals,filteredTotals,current,detail,analysis};
}
export const graph=hotCellGraph(appScope.name,createCells,import.meta.hot);
if(import.meta.hot)import.meta.hot.accept();
const kit=agentToolkit(appScope.name,{brief:'Inspect a real selected history corpus ingested into an isolated local DuckDB. Session filters affect only the table; analysis presets query the whole database. Save changes to native history.yaml, then explicitly sync. No inference or cloud publishing.'});
registerStandardTools(kit);
kit.registerReporter('data',()=>({view:view.get(),rows:graph().rows.latest()?.length??0,totals:graph().filteredTotals.latest(),
 selected:graph().current.latest()?.thread_id,configPath:graph().config.latest()?.path,pricing:graph().snapshot.latest()?.pricingVersion}));

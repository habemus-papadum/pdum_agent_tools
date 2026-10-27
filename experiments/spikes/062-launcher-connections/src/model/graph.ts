import {agentToolkit,cell,hotCellGraph,registerStandardTools} from '@habemus-papadum/aiui-viz';
import {api,type Inventory} from './api';
import {appScope,connections,inspection,query,revision,target} from './store';
export const graph=hotCellGraph(appScope.name,()=>{
 const inventory=cell(()=>revision.get(),async(_rev,ctx):Promise<Inventory>=>{try{return await api<Inventory>('inventory',undefined,ctx.signal);}catch(error){if(ctx.signal.aborted)throw error;return {host:'Unavailable',observedAt:0,labRoot:'',profiles:[],roots:[],capabilities:{},error:String(error)};}},{scope:appScope});
 const rows=cell(()=>({items:inventory().profiles,q:query.get()}),({items,q})=>items.filter(p=>`${p.name} ${p.path} ${p.provider}`.toLowerCase().includes(q.toLowerCase())),{scope:appScope});
 const remote=cell(()=>({rows:connections.get(),url:target.get()}),({rows,url})=>rows.find(r=>r.url===url)??null,{scope:appScope});
 return {inventory,rows,remote};
},import.meta.hot);
if(import.meta.hot)import.meta.hot.accept();
export const kit=agentToolkit(appScope.name,{brief:'Real read-only launcher discovery. Refresh reads local metadata; inspect-profile invokes the existing provider library. Connect reads existing HTTP management adapters, never agent WebSockets. No process is launched/stopped and no credentials are read. Snapshots are point-in-time observations; Claude workers are manager-local.'});
registerStandardTools(kit);
kit.registerReporter('connections',()=>({host:graph().inventory.latest()?.host,profiles:graph().rows.latest()?.map(p=>({id:p.id,name:p.name,provider:p.provider,editable:p.editable})),selected:target.get(),inspection:inspection.get()?.scope,connections:connections.get().map(r=>({url:r.url,reachable:r.reachable,observedAt:r.observedAt}))}));

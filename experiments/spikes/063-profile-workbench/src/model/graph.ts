import {agentToolkit,cell,hotCellGraph,registerStandardTools} from '@habemus-papadum/aiui-viz';
import {api,type Inventory} from '../../../062-launcher-connections/src/model/api';
import {appScope,document,draft,query,revision,runModel} from './store';
const quote=(s:string)=>`'${s.replaceAll("'", "'\\''")}'`;
export const graph=hotCellGraph(appScope.name,()=>{
 const inventory=cell(()=>revision.get(),async(_rev,ctx):Promise<Inventory>=>{try{return await api<Inventory>('inventory',undefined,ctx.signal);}catch(error){if(ctx.signal.aborted)throw error;return {host:'Unavailable',observedAt:0,labRoot:'',profiles:[],roots:[],capabilities:{},error:String(error)};}},{scope:appScope});
 const rows=cell(()=>({items:inventory().profiles,q:query.get()}),({items,q})=>items.filter(p=>`${p.name} ${p.path} ${p.provider}`.toLowerCase().includes(q.toLowerCase())),{scope:appScope});
 const changes=cell(()=>({doc:document.get(),draft:draft.get()}),({doc,draft})=>({dirty:!!doc&&doc.text!==draft,originalLines:doc?.text.split('\n').length??0,currentLines:draft.split('\n').length}),{scope:appScope});
 const launch=cell(()=>({doc:document.get(),model:runModel.get()}),({doc,model})=>doc?{command:`uv run pdum-${doc.profile.provider} --profile-dir ${quote(doc.profile.path)} launch${model&&doc.profile.provider==='codex'?` --model ${quote(model)}`:''}`,allocation:doc.profile.provider==='claude'&&model?JSON.stringify({profileId:doc.profile.name,options:{model}},null,2):null}:null,{scope:appScope});
 return {inventory,rows,changes,launch};
},import.meta.hot);
if(import.meta.hot)import.meta.hot.accept();
export const kit=agentToolkit(appScope.name,{brief:'Real profile workbench. Existing profiles may be inspected or used as bases; writes target only the isolated lab root. prepare-profile opens a form, create-profile uses the production launcher, save-native-config writes native TOML/JSON with revision checking. No login, worker launch or model call. Config can contain sensitive values; do not paste raw values into reports.'});
registerStandardTools(kit);
kit.registerReporter('workbench',()=>({host:graph().inventory.latest()?.host,profile:document.get()?.profile,dirty:graph().changes.latest()?.dirty,writeScope:'lab profiles only'}));

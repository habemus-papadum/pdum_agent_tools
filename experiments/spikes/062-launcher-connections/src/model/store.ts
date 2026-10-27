import {action,control,scope} from '@habemus-papadum/aiui-viz';
import {api,type Connection,type Inspection,type Provider} from './api';
export const appScope=scope('launcher-connections');
/** Reread local profile roots. Does not start or attach to a provider runtime. */
export const revision=control({scope:appScope,value:0});
/** Provider-specific management adapter to query. */
export const provider=control<Provider>({scope:appScope,value:'claude',options:['codex','claude']});
/** HTTP base URL of an existing manager; no automatic discovery scans. */
export const endpoint=control({scope:appScope,value:''});
/** Optional ordinary profile directory to inspect read-only. */
export const directory=control({scope:appScope,value:''});
/** Search local profile names and locations. */
export const query=control({scope:appScope,value:''});
export const busy=appScope.durableSignal('busy',false);
export const error=appScope.durableSignal('error','');
export const inspection=appScope.durableSignal<Inspection|null>('inspection',null);
export const connections=appScope.durableSignal<Connection[]>('connections',[]);
/** Selected endpoint snapshot; local means this preview host's filesystem. */
export const target=control({scope:appScope,value:'local'});
/** Refresh profile metadata without probing any provider daemon. */
export const refresh=action({scope:appScope,name:'refresh',group:'observe',run:()=>revision.set(x=>x+1)});
/** Inspect an existing profile using its owning launcher. Codex reports processes; Claude metadata has no global worker list. */
export const inspect=action({scope:appScope,name:'inspect-profile',group:'observe',params:{provider:'codex or claude',path:'Existing profile directory'},run:async args=>{
  if(busy.get())return; const chosen={provider:args?.provider??provider.get(),path:args?.path??directory.get()};busy.set(true);error.set('');inspection.set(null);target.set('local');
  try{const value=await api<Inspection>('inspect',chosen);inspection.set(value);}catch(e){error.set(String(e));}finally{busy.set(false);}
}});
/** Read the selected manager's existing status endpoints. Failure preserves the previous snapshot and marks the new observation failed. */
export const connect=action({scope:appScope,name:'connect',group:'connections',run:async()=>{
  if(busy.get())return;const chosen={provider:provider.get(),url:endpoint.get()};busy.set(true);error.set('');
  try{const value=await api<Connection>('connect',chosen);connections.set(rows=>{const old=rows.find(r=>r.url===value.url);return [{...value,previous:!value.reachable?(old?.reachable?old:old?.previous):undefined},...rows.filter(r=>r.url!==value.url)];});target.set(value.url);}catch(e){error.set(String(e));}finally{busy.set(false);}
}});
/** Remove a saved-in-this-tab observation. No stop request is sent to the manager. */
export const forget=action({scope:appScope,name:'forget-endpoint',group:'connections',run:()=>{const url=target.get();connections.set(rows=>rows.filter(r=>r.url!==url));target.set('local');}});

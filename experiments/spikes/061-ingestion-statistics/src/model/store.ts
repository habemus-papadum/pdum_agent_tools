import {action,control,scope} from '@habemus-papadum/aiui-viz';
import type {Job} from './data';
export const appScope=scope('ingestion-statistics');
/** The data view. All analysis questions query the whole saved database, independent of table filters. */
export const view=control({scope:appScope,value:'sessions',options:['sessions','analysis','sources','runs']});
/** Filter the session table by source provider. */
export const provider=control({scope:appScope,value:'all',options:['all','codex','claude']});
/** Find a session by title, project, model or native identity. */
export const search=control({scope:appScope,value:''});
/** Sort session rows by an observed measurement. */
export const sort=control({scope:appScope,value:'known_usd',options:['known_usd','input_tokens','errors','items','name']});
/** Existing production analysis question to execute against the local database. */
export const question=control({scope:appScope,value:'Q1'});
/** Full-text term used by the existing Q5 query. */
export const term=control({scope:appScope,value:'agent'});
export const configOpen=control({scope:appScope,value:false});
export const notesOpen=control({scope:appScope,value:false});
export const inspectorOpen=control({scope:appScope,value:true});
export const selected=appScope.durableSignal('selected-session','');
export const revision=appScope.durableSignal('read-revision',0);
export const draft=appScope.durableSignal<string|null>('config-draft',null);
export const notice=appScope.durableSignal('operation-notice','');
export const liveJob=appScope.durableSignal<Job|null>('live-job',null);
export async function request<T>(path:string,init:RequestInit={}):Promise<T>{
 const response=await fetch(`/__ingestion/${path}`,{cache:'no-store',...init});const data=await response.json();
 if(!response.ok)throw new Error(data.error||`Request failed (${response.status})`);return data;
}
/** Reread saved data and the last observed sync. Does not ingest or contact a provider. */
export const refresh=action({scope:appScope,name:'refresh',group:'data',run:()=>revision.set(v=>v+1)});
/** Save native history.yaml in this study's lab directory after the real parser validates it. */
export const saveConfig=action({scope:appScope,name:'save-config',group:'configuration',run:async()=>{
 const value=draft.get();if(value===null)return {effect:'No edits'};
 try {await request('config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:value})});
 draft.set(null);notice.set('Configuration saved. The next sync uses these sources and targets.');revision.set(v=>v+1);}
 catch(error){notice.set(String(error));throw error;}
}});
/** Incrementally sync the saved native config into the isolated local database. No provider inference. */
export const syncNow=action({scope:appScope,name:'sync-now',group:'data',run:async()=>{
 if(liveJob.get()?.status==='running')return {effect:'Already observing a running sync'};
 notice.set('');
 try {const started=await request<Job>('sync',{method:'POST'});liveJob.set(started);
 let current=started;
 while(current.status==='running'){await new Promise(r=>setTimeout(r,600));
 const result=await request<{job:Job}>('status');current=result.job;liveJob.set(current);}
 notice.set(current.status==='complete'?'Sync complete. Unchanged files were skipped.':current.error||`Sync ${current.status}`);
 revision.set(v=>v+1);return {id:current.id,status:current.status};
 }catch(error){notice.set(String(error));throw error;}
}});
/** Select a statistical session row; no live agent is attached. */
export const selectSession=action({scope:appScope,name:'select-session',group:'inspection',params:{key:'Source identity / native thread identity'},run:args=>{
 selected.set(String(args?.key??''));inspectorOpen.set(true);
}});

import {action,control,scope} from '@habemus-papadum/aiui-viz';
import {api,type Profile,type Provider} from '../../../062-launcher-connections/src/model/api';
export interface Document {profile:Profile;text:string;revision:string;format:'toml'|'json';observedAt:number;}
export const appScope=scope('profile-workbench');
const initial=typeof location==='undefined'?new URLSearchParams():new URLSearchParams(location.search);
export const revision=control({scope:appScope,value:0});
/** Search the real local profile inventory. */
export const query=control({scope:appScope,value:''});
/** Provider for the new local lab profile. */
export const provider=control<Provider>({scope:appScope,value:initial.get('provider')==='claude'?'claude':'codex',options:['codex','claude']});
/** New directory name under the lab's provider root. */
export const name=control({scope:appScope,value:''});
/** Model saved as a profile default. This never submits a model request. */
export const model=control({scope:appScope,value:'gpt-6-luna'});
/** Existing working directory, used by Claude profile creation. */
export const workspace=control({scope:appScope,value:''});
/** Entire native configuration text. Unknown fields and comments remain until explicitly edited. */
export const draft=control({scope:appScope,value:''});
/** A one-run model override preview; independent of the file editor. */
export const runModel=control({scope:appScope,value:''});
/** Show the create/copy form. */
export const creating=control({scope:appScope,value:false});
export const document=appScope.durableSignal<Document|null>('document',null);
export const source=appScope.durableSignal<Profile|null>('source',null);
export const busy=appScope.durableSignal('busy',false);
export const error=appScope.durableSignal('error','');
export const receipt=appScope.durableSignal('receipt','');
export const initialPath=initial.get('path')??'';
/** Reread profile inventory. */
export const refresh=action({scope:appScope,name:'refresh',group:'profiles',run:()=>revision.set(n=>n+1)});
/** Explicitly inspect native configuration. Existing profiles remain read-only in this study. */
export const open=action({scope:appScope,name:'open-profile',group:'profiles',params:{provider:'codex or claude',path:'Existing profile directory'},run:async args=>{
 if(busy.get())return;const previous=document.get();if(previous&&previous.text!==draft.get()&&args?.path!==previous.profile.path){error.set('Save or discard the current edits before opening another profile.');return;}const chosen={provider:args?.provider,path:args?.path};busy.set(true);error.set('');receipt.set('');document.set(null);
 try{const value=await api<Document>('read',chosen);document.set(value);draft.set(value.text);runModel.set('');creating.set(false);}catch(e){error.set(String(e));}finally{busy.set(false);}
}});
/** Begin a profile from scratch or the selected native configuration. No files are written yet. */
export const prepare=action({scope:appScope,name:'prepare-profile',group:'profiles',params:{copy:'true to base on the open profile'},run:args=>{
 const old=document.get();if(old&&old.text!==draft.get()){error.set('Save or discard the current edits before preparing another profile.');return;}const base=args?.copy?old?.profile??null:null;source.set(base);provider.set(base?.provider??provider.get());name.set(base?`${base.name}-copy`:'');model.set(base?.model??(provider.get()==='claude'?'haiku':'gpt-6-luna'));workspace.set(base?.workspace??'');creating.set(true);error.set('');receipt.set('');
}});
/** Create a real profile through its launcher inside the lab directory. No auth credential files, sessions or skills are copied. */
export const create=action({scope:appScope,name:'create-profile',group:'profiles',run:async()=>{
 if(busy.get())return;const values={provider:source.get()?.provider??provider.get(),name:name.get(),model:model.get(),workspace:workspace.get(),source:source.get()?.path};
 busy.set(true);error.set('');receipt.set('');
 try{const result=await api<{profile:Profile;effect:string;warnings:string[]}>('create',values);const value=await api<Document>('read',{provider:result.profile.provider,path:result.profile.path});document.set(value);draft.set(value.text);creating.set(false);source.set(null);revision.set(n=>n+1);receipt.set(`${result.effect} ${result.warnings.join(' ')}`);}catch(e){error.set(String(e));}finally{busy.set(false);}
}});
/** Save the open lab profile's native text, validating its format and checking the file revision. Does not reconfigure any worker. */
export const save=action({scope:appScope,name:'save-native-config',group:'profiles',run:async()=>{
 const doc=document.get();if(!doc?.profile.editable||busy.get())return;const text=draft.get();busy.set(true);error.set('');receipt.set('');
 try{const result=await api<{profile:Profile;revision:string;effect:string}>('save',{provider:doc.profile.provider,path:doc.profile.path,revision:doc.revision,text});document.set({...doc,profile:result.profile,text,revision:result.revision});revision.set(n=>n+1);receipt.set(result.effect);}catch(e){error.set(String(e));}finally{busy.set(false);}
}});

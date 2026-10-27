/** Curated review points refer to native identities, never guessed positions or invented relationships. */
import {object} from './native';
import type {FamilyLane} from './family';
export interface ExampleBookmark {
  id:string; label:string; documentKey:string; provider:string; role:string;
  phase:string|null; turnId:string|null; itemId:string|null; uuid:string|null; features:string[];
}
export function exampleBookmarks(value:unknown):ExampleBookmark[]{
  if(!Array.isArray(value))return [];
  return value.flatMap(raw=>{
    const v=object(raw),string=(key:string)=>typeof v[key]==='string'?v[key] as string:null;
    const id=string('id'),label=string('label'),documentKey=string('documentKey'),provider=string('provider'),role=string('role');
    if(!id||!label||!documentKey||!provider||!role)return [];
    return [{id,label,documentKey,provider,role,phase:string('phase'),turnId:string('turnId'),itemId:string('itemId'),uuid:string('uuid'),
      features:Array.isArray(v.features)?v.features.filter((x):x is string=>typeof x==='string'):[]}];
  });
}
export function resolveExample(lanes:readonly FamilyLane[],bookmark:ExampleBookmark){
  const lane=lanes.find(lane=>lane.key===bookmark.documentKey&&lane.entry.provider===bookmark.provider);
  if(!lane)return {available:false as const,reason:'The example capture is not loaded'};
  const nativeId=bookmark.itemId||bookmark.uuid;
  if(!nativeId)return {available:false as const,reason:'The example has no native item identity'};
  const matches=lane.items.filter(item=>item.nativeId===nativeId&&(!bookmark.turnId||item.turnId===bookmark.turnId));
  if(matches.length!==1)return {available:false as const,reason:'The native example is missing or ambiguous'};
  const item=matches[0];
  if(item.role!==bookmark.role||(bookmark.phase!==null&&item.phase!==bookmark.phase))return {available:false as const,reason:'The native message role or phase differs from the bookmark'};
  return {available:true as const,lane,item};
}

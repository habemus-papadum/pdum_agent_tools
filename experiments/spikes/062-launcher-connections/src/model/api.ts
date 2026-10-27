export type Provider='codex'|'claude';
export interface Profile {id:string;provider:Provider;path:string;name:string;origin:string;editable:boolean;nativePath:string;model?:string|null;workspace?:string|null;executable?:string;authEvidence?:string;managed?:boolean;isolated?:boolean;error?:string;settingSources?:string[];}
export interface Inventory {host:string;observedAt:number;labRoot:string;profiles:Profile[];roots:{provider:string;path:string;exists:boolean}[];capabilities:Record<string,unknown>;error?:string;}
export interface Inspection {profile:Profile;observedAt:number;processes:Record<string,any>[]|null;processSummary?:Record<string,number>;runs:Record<string,any>[]|null;databases?:Record<string,any>[];writers?:unknown[];scope:string;warnings:string[];}
export interface Connection {url:string;provider:Provider;observedAt:number;reachable:boolean;checks:{path:string;status:number|null;data?:any;error?:string}[];note:string;previous?:Connection;}
export async function api<T>(route:string,body?:unknown,signal?:AbortSignal):Promise<T>{const response=await fetch(`/__management-lab/${route}`,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal,cache:'no-store'});const value=await response.json();if(!response.ok||value.error)throw new Error(value.error||`HTTP ${response.status}`);return value;}
export const formatTime=(value?:number)=>value?new Date(value*1000).toLocaleTimeString(): '—';
export const workbenchUrl=(p:Profile)=>`/profiles/?provider=${p.provider}&path=${encodeURIComponent(p.path)}`;

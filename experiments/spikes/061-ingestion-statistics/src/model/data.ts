export type Row=Record<string,unknown>;
export interface Session extends Row {
  source_id:string;thread_id:string;session_id:string|null;source:string;title:string|null;cwd:string|null;repo:string|null;model:string|null;
  items:number;errors:number;usage_events:number|null;input_tokens:number|null;cached_input_tokens:number|null;output_tokens:number|null;
  known_usd:number|null;priced_events:number|null;unpriced_events:number|null;peak_context:number|null;context_window:number|null;
}
export interface Snapshot {available:boolean;reason?:string;sessions:Session[];pricingVersion:string;provenance:Row[];ledger:Row[];phases:Row[];questions:{id:string;title:string;tables:string[]}[];capturedAt:string;}
export interface Configuration {available:boolean;reason?:string;path:string;text:string;notes:string[];windowDays:number|null;blobs:boolean;sources:{agent:string;root:string;label:string}[];targets:{name:string;path:string;exists:boolean}[];}
export interface Job {id:string;status:string;startedAt:string;finishedAt?:string;error?:string;events:Row[];summaries:Row[];}
export interface QuestionResult {available:boolean;title:string;columns:string[];result:Row[];sql:string;rows:number;coldMs:number;error?:string;}
export interface Detail {available:boolean;coverage:Row[];usage:Row[];tools:Row[];ledger:Row[];}
export const sessionKey=(row:Session)=>`${row.source_id}/${row.thread_id}`;
export const providerOf=(row:Session)=>row.source.startsWith('claude')?'claude':'codex';
export const titleOf=(row:Session)=>row.title||row.repo||row.cwd?.split('/').pop()||row.thread_id;
export function selectRows(rows:Session[],provider:string,search:string,sort:string){
 const query=search.toLowerCase();return rows.filter(row=>(provider==='all'||providerOf(row)===provider)&&
 [row.title,row.cwd,row.repo,row.thread_id,row.model].some(value=>String(value??'').toLowerCase().includes(query)))
 .sort((a,b)=>sort==='name'?titleOf(a).localeCompare(titleOf(b)):
 Number(b[sort]??-1)-Number(a[sort]??-1));
}
export function totals(rows:Session[]){return rows.reduce((sum,row)=>({count:sum.count+1,cost:sum.cost+(row.known_usd??0),
 input:sum.input+(row.input_tokens??0),output:sum.output+(row.output_tokens??0),cached:sum.cached+(row.cached_input_tokens??0),
 items:sum.items+row.items,errors:sum.errors+row.errors,unpriced:sum.unpriced+(row.unpriced_events??0),
 withoutUsage:sum.withoutUsage+(row.usage_events?0:1)}),{count:0,cost:0,input:0,output:0,cached:0,items:0,errors:0,unpriced:0,withoutUsage:0});}
export function number(value:unknown){if(value==null)return '—';const n=Number(value);return Number.isFinite(n)?Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(n):String(value);}
export const money=(value:unknown)=>value==null?'—':`$${Number(value).toFixed(2)}`;
export const text=(value:unknown)=>value==null?'—':typeof value==='object'?JSON.stringify(value):String(value);

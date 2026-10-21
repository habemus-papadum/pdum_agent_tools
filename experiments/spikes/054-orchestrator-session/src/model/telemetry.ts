/** Pure fixture telemetry. Rates illustrate accounting; they are not provider prices. */
export type Metric = 'time' | 'cost' | 'tokens' | 'context';
export type Kind = 'user' | 'model' | 'tool' | 'compaction';
export interface Usage { input: number; cachedInput: number; output: number; }
export interface TimelineItem {
  id: string; kind: Kind; time: number; label: string; text: string;
  turn: number; requestId?: string; parentRequestId?: string; usage?: Usage | null;
  context?: number | null; contextBefore?: number; contextWindow?: number;
  duration?: number; command?: string; output?: string; fileReference?: boolean;
  status?: 'completed' | 'failed' | 'running'; diagnostic?: string;
}
export const PRICE_CARD = { id: 'illustrative-2026-10-19', input: 2, cachedInput: 0.2, output: 8 };
export const fixtureItems: readonly TimelineItem[] = [
  { id:'u1',kind:'user',time:0,turn:10,label:'You',text:'Find why a cancelled request sometimes starts another retry. Keep the patch small and show the behavior before changing it.' },
  { id:'m1',kind:'model',time:5,turn:10,label:'Agent',requestId:'r1',usage:{input:18000,cachedInput:12000,output:840},context:18840,contextWindow:128000,text:'I’ll trace cancellation through the retry loop, then inspect its callers and tests.' },
  { id:'t1',kind:'tool',time:9,turn:10,label:'Read retry implementation',parentRequestId:'r1',duration:.4,status:'completed',command:"sed -n '1,18p' src/retry.ts",output:'18 lines read. The delay is inside the catch block.',fileReference:true,text:'' },
  { id:'t2',kind:'tool',time:12,turn:10,label:'Search retry callers',parentRequestId:'r1',duration:.3,status:'completed',command:'rg "retry\\(" src',output:'src/client.ts:73\nsrc/transport.ts:114',text:'' },
  { id:'m2',kind:'model',time:24,turn:10,label:'Agent',requestId:'r2',usage:{input:21200,cachedInput:18500,output:1100},context:22300,contextWindow:128000,text:'The signal is checked before the first attempt, but not after the delay. Cancellation during backoff can therefore start another attempt.' },
  { id:'t3',kind:'tool',time:31,turn:10,label:'Run cancellation tests',parentRequestId:'r2',duration:3.8,status:'failed',command:'pnpm test -- retry.test.ts',output:'FAIL retry.test.ts\nExpected attempts: 1\nReceived attempts: 2\nAbort reason: Error("cancelled")',diagnostic:'Test assertion failed · exit 1. This is a task finding, not a provider or sandbox failure.',text:'' },
  { id:'u2',kind:'user',time:42,turn:11,label:'You',text:'Also check whether callers expect the original abort reason to survive.' },
  { id:'m3',kind:'model',time:47,turn:11,label:'Agent',requestId:'r3',usage:null,context:null,contextWindow:128000,text:'I’ll inspect the call chain and preserve the original abort reason.' },
  { id:'t4',kind:'tool',time:52,turn:11,label:'Read request tracing output',parentRequestId:'r3',duration:.8,status:'completed',command:'cat artifacts/request-trace.txt',output:'Cancellation requested during backoff. Attempt 2 began after signal.aborted became true.',text:'' },
  { id:'m4',kind:'model',time:80,turn:11,label:'Agent',requestId:'r4',usage:{input:54000,cachedInput:23000,output:5000},context:59000,contextWindow:128000,text:'The trace confirms the race. The caller forwards the same AbortSignal, but retry() starts another attempt after the delay.' },
  { id:'t5',kind:'tool',time:88,turn:11,label:'Inspect abort reason contract',parentRequestId:'r4',duration:.2,status:'completed',command:'rg "throwIfAborted|signal.reason" src',output:'Callers rely on signal.reason; preserve its identity.',text:'' },
  { id:'compact1',kind:'compaction',time:94,turn:11,label:'Context compacted',contextBefore:59000,context:16500,contextWindow:128000,text:'Working context replaced with a retained summary. Transcript history stays available.' },
  { id:'m5',kind:'model',time:106,turn:12,label:'Agent',requestId:'r5',usage:{input:19000,cachedInput:16500,output:720},context:19720,contextWindow:128000,text:'I’ll add signal.throwIfAborted() after the delay and retain the existing initial check. Both cancellation cases will share the original abort reason.' },
  { id:'t6',kind:'tool',time:112,turn:12,label:'Apply the focused patch',parentRequestId:'r5',duration:.3,status:'completed',command:'apply_patch src/retry.ts',output:'+ signal.throwIfAborted();\n1 file changed.',text:'' },
  { id:'m6',kind:'model',time:120,turn:12,label:'Agent',requestId:'r6',usage:{input:21500,cachedInput:19000,output:560},context:22060,contextWindow:128000,text:'The patch is in place. I’m running the focused regression suite before reporting the result.' },
  { id:'t7',kind:'tool',time:124,turn:12,label:'Run focused tests',parentRequestId:'r6',duration:4.2,status:'running',command:'pnpm test -- retry.test.ts',output:'retry semantics\n  ✓ stops before the first attempt\n  ◌ cancellation during backoff',text:'' },
];
export function estimatedCost(usage: Usage): number {
  if (usage.input < 0 || usage.cachedInput < 0 || usage.cachedInput > usage.input || usage.output < 0) throw new Error('Invalid usage partition');
  return ((usage.input-usage.cachedInput)*PRICE_CARD.input+usage.cachedInput*PRICE_CARD.cachedInput+usage.output*PRICE_CARD.output)/1e6;
}
export function fixture(coverage: 'partial' | 'complete'): TimelineItem[] {
  return fixtureItems.map(item=> item.id==='m3' && coverage==='complete' ? {...item,usage:{input:24200,cachedInput:21000,output:650},context:24850}: {...item});
}
export interface ProjectionRow {
  item: TimelineItem; cost: number | null; cumulativeCost: number; cumulativeTokens: number;
  context: number | null; contextKnown: boolean; attribution: string; unknownBefore: number;
}
export function projectTelemetry(items: readonly TimelineItem[]) {
  let totalCost=0,input=0,cachedInput=0,output=0,knownRequests=0,requests=0,unknown=0;
  let context:number|null=null, contextKnown=false;
  const seen=new Set<string>();
  const rows:ProjectionRow[]=items.map(item=> {
    let cost:number|null=null;
    let attribution='No independent model charge';
    if(item.requestId){
      if(seen.has(item.requestId)) throw new Error(`Duplicate model request ${item.requestId}`);
      seen.add(item.requestId); requests++;
      if(item.usage){cost=estimatedCost(item.usage);totalCost+=cost;input+=item.usage.input;cachedInput+=item.usage.cachedInput;output+=item.usage.output;knownRequests++;attribution=`Model request ${item.requestId}; cached input is part of input, not additional tokens`;}
      else {unknown++;attribution=`Model request ${item.requestId}; usage unavailable, excluded from known totals`;}
      contextKnown=typeof item.context==='number';context=item.context??context;
    }else if(item.kind==='compaction'){context=item.context??context;contextKnown=typeof item.context==='number';attribution='Context snapshot, not additional usage; compaction cost unavailable';}
    else if(item.parentRequestId) attribution=`Tool belongs to ${item.parentRequestId}; model usage is counted on that request only`;
    return {item,cost,cumulativeCost:totalCost,cumulativeTokens:input+output,context,contextKnown,attribution,unknownBefore:unknown};
  });
  return {rows,totals:{cost:totalCost,input,cachedInput,output,tokens:input+output,knownRequests,requests,unknownRequests:unknown,cacheShare:input?cachedInput/input:0,context,contextKnown,contextWindow:128000,compactionCostKnown:false,pricing:PRICE_CARD.id,coverage:'Known request usage only; compaction charge unavailable'}};
}
export type Ledger=ReturnType<typeof projectTelemetry>;
export interface NavigationPoint {id:string;position:number;value:number|null;known:boolean;label:string;status:string;}
export function navigationPoints(ledger:Ledger,metric:Metric):NavigationPoint[] {
  const maxTime=Math.max(1,...ledger.rows.map(r=>r.item.time));
  const maximum=metric==='cost'?Math.max(ledger.totals.cost,.000001):metric==='tokens'?Math.max(ledger.totals.tokens,1):metric==='context'?128000:maxTime;
  return ledger.rows.map(row=> {
    const value=metric==='time'?row.item.time:metric==='cost'?row.cumulativeCost:metric==='tokens'?row.cumulativeTokens:row.contextKnown?row.context:null;
    const known=metric==='cost'||metric==='tokens'?row.unknownBefore===0:metric==='context'?row.contextKnown:true;
    return {id:row.item.id,position:value===null?0:value/maximum,value,known,label:row.item.label,status:row.item.status??row.item.kind};
  });
}
export function formatNumber(n:number):string {return n>=1000?`${(n/1000).toFixed(n>=10000?1:2)}k`:String(n);}
export function formatMoney(n:number):string {return `$${n.toFixed(3)}`;}
export function formatTime(seconds:number):string {return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}

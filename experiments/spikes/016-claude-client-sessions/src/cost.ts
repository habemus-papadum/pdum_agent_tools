import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJson } from "../../014-claude-app-server/src/launch.js";

type Json=Record<string,unknown>;
const rates={input:0.1,output:0.5,cacheRead:0.01,cacheWrite5m:0.125,cacheWrite1h:0.2};
export function priceTurn(result:Json): {usdRange:number[];tokens:Json;exactTtl:boolean}|null {
  const models=Object.entries(result.modelUsage as Json??{});
  if(!models.length||models.some(([name,value])=>!String((value as Json).canonicalModel??name).startsWith("claude-haiku-5-5")))return null;
  const usage=result.usage as Json|undefined;if(!usage)return null;
  const input=Number(usage.input_tokens??0),output=Number(usage.output_tokens??0),read=Number(usage.cache_read_input_tokens??0),write=Number(usage.cache_creation_input_tokens??0);
  if(input+read+write>100000)return null;
  const cache=usage.cache_creation as Json|undefined;
  const five=Number(cache?.ephemeral_5m_input_tokens??0),hour=Number(cache?.ephemeral_1h_input_tokens??0);
  const exactTtl=!!cache&&five+hour===write;
  const base=(input*rates.input+output*rates.output+read*rates.cacheRead)/1e6;
  const exact=base+(five*rates.cacheWrite5m+hour*rates.cacheWrite1h)/1e6;
  return {usdRange:exactTtl?[exact,exact]:[base+write*rates.cacheWrite5m/1e6,base+write*rates.cacheWrite1h/1e6],tokens:{input,output,cacheRead:read,cacheWrite:write,fiveMinuteWrites:five,oneHourWrites:hour},exactTtl};
}
function frames(path:string):Json[]{
  return existsSync(path)?readFileSync(path,"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line) as Json):[];
}
/** Price our public wire events. Never inspect Claude's private transcript cost records. */
export function writeBrowserCostLedger(out:string,authentication:string,live:boolean){
  const workers=JSON.parse(readFileSync(join(out,"manager/workers.json"),"utf8")) as Array<{id:string;conversationId:string;startedAt:string;stoppedAt?:string}>;
  const attempts:Json[]=[];const controlOnly:Json[]=[];const totals=new Map<string,number>();
  for(const worker of workers.sort((a,b)=>a.startedAt.localeCompare(b.startedAt))){
    const dir=join(out,"manager",worker.id);
    const inputs=frames(join(dir,"relay-input.ndjson")).filter(f=>f.type==="user");
    if(!live||!inputs.length){controlOnly.push({...worker,submittedInputs:inputs.length,liveEnabled:live});continue;}
    const results=frames(join(dir,"stdout.ndjson")).filter(f=>f.type==="result");
    const last=results.at(-1);const estimates=results.map(priceTurn);
    const estimateComplete=results.length===inputs.length&&estimates.every(e=>e!==null);
    const estimate=estimateComplete?[0,1].map(i=>estimates.reduce((sum,item)=>sum+item!.usdRange[i]!,0)):null;
    const current=typeof last?.total_cost_usd==="number"?last.total_cost_usd:null;
    const previous=totals.get(worker.conversationId);
    const candidate=current===null?null:current-(previous??0);
    // For a first-seen history/fork, a cumulative total is not automatically a new charge.
    // Only allocate it when the independent per-turn price agrees in this bounded probe.
    const agreement=candidate!==null&&estimate!==null&&candidate>=estimate[0]!-1e-10&&candidate<=estimate[1]!+1e-10;
    const allocated=agreement?candidate:null;
    if(current!==null)totals.set(worker.conversationId,current);
    attempts.push({...worker,submittedInputs:inputs.length,results,turnEstimates:estimates,
      previousObservedConversationTotalUsd:previous??null,sdkCumulativeUsd:current,sdkAllocatedUsd:allocated,
      allocationBasis:agreement?(previous===undefined?"First observed cumulative amount agrees with independently priced turn usage":"Difference from previous observed conversation total agrees with turn usage"):"Unknown allocation; missing result or cumulative cost disagrees with independently priced turns",
      estimateUsdRange:estimate,complete:agreement&&estimateComplete});
  }
  const complete=attempts.every(a=>a.complete===true);
  const knownSdk=attempts.reduce((sum,a)=>sum+Number(a.sdkAllocatedUsd??0),0);
  const ledger={asOf:new Date().toISOString(),authentication,selectedModel:"claude-haiku-5-5",attempts,controlOnly,
    completeness:complete?"All submitted live probe inputs have final usage and reconciled estimates":"Incomplete: unknown amounts are excluded from observed subtotal, not counted as zero",
    observedSdkSubtotalUsd:knownSdk,totalSdkEstimatedUsd:complete?knownSdk:null,
    observedPriceEstimateUsdRange:[0,1].map(i=>attempts.reduce((sum,a)=>sum+Number((a.estimateUsdRange as number[]|null)?.[i]??0),0)),
    usdPerMillion:rates,priceSource:"https://platform.claude.com/docs/en/models/haiku-5-5/overview",
    accounting:"Public result usage plus preceding observed wire totals. Cache TTL is used when present. No private transcript parser. Missing final results are unknown, not zero.",
    actualBilling:"Not measured. SDK/list-price estimates exclude unreported provider work and orchestration-agent costs."};
  writeJson(join(out,"cost-ledger.json"),ledger);return ledger;
}

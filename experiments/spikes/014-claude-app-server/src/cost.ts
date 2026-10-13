import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, unknown>;
const source="https://platform.claude.com/docs/en/models/haiku-5-5/overview";
const rates={input:0.10,output:0.50,cacheRead:0.01,cacheWrite5m:0.125,cacheWrite1h:0.20};
function objects(value:unknown): Json[] {return Array.isArray(value)?value.filter((x):x is Json=>!!x&&typeof x==="object"):[];}
function price(modelUsage: unknown) {
  if(!modelUsage||typeof modelUsage!=="object")return null;
  const models=Object.entries(modelUsage as Json);
  if(models.some(([name])=>!name.startsWith("claude-haiku-5-5")))return {status:"unpriced model",models:models.map(([name])=>name)};
  const counts={input:0,output:0,cacheRead:0,cacheWrite:0};
  for(const [,entry] of models){
    const v=entry as Json;
    counts.input+=Number(v.inputTokens??0);counts.output+=Number(v.outputTokens??0);
    counts.cacheRead+=Number(v.cacheReadInputTokens??0);counts.cacheWrite+=Number(v.cacheCreationInputTokens??0);
  }
  const totalInput=counts.input+counts.cacheRead+counts.cacheWrite;
  if(totalInput>100000)return {status:"requires per-request context tiers",tokens:counts};
  const base=counts.input*rates.input+counts.output*rates.output+counts.cacheRead*rates.cacheRead;
  return {status:"estimated",tokens:counts,usdRange:[(base+counts.cacheWrite*rates.cacheWrite5m)/1e6,(base+counts.cacheWrite*rates.cacheWrite1h)/1e6],assumption:"All requests <=100k input; cache write TTL unavailable, so range spans 5-minute and 1-hour writes"};
}

/** Aggregate recorded attempts, retaining failures and avoiding repeated cumulative turn costs. */
export function writeCostLedger(runDirectory:string,authentication:string) {
  const attempts:Json[]=[];
  function visit(directory:string){
    for(const entry of readdirSync(directory,{withFileTypes:true})){
      const path=join(directory,entry.name);
      if(entry.isDirectory()){
        // Profiles contain raw state, not cost manifests.
        if(!/profile|worker|baseline/.test(entry.name))visit(path);
      } else if(entry.name==="summary.json"){
        const summary=JSON.parse(readFileSync(path,"utf8")) as Json;
        if(!String(summary.name).startsWith("live-"))continue;
        const reports=objects(summary.usage);const last=reports.at(-1);
        attempts.push({name:summary.name,status:summary.status,model:summary.selectedModel,record:path,
          results:reports.map(r=>({sessionId:r.sessionId,resultSubtype:r.subtype,rawUsage:r.usage,sdkCumulativeUsd:r.totalCostUsd})),
          sdkReportedUsd:last?.totalCostUsd??null,priceEstimate:price(last?.modelUsage),
          completeness:last?"Final observed result; an interrupted later request may be unaccounted":"No result usage; cost unknown, not zero"});
      } else if(entry.name==="storage-live.json"){
        const live=JSON.parse(readFileSync(path,"utf8")) as Json;
        for(const a of objects(live.attempts))attempts.push({name:`storage-${a.name}`,status:a.status,model:a.model,record:path,sessionId:a.sessionId,rawUsage:a.mainLoopTurnUsage,baseline:a.baseline,sdkCumulativeUsd:a.sdkCumulativeCostUsd??null,sdkReportedUsd:a.sdkIncrementalCostUsd??null,priceEstimate:a.priceEstimate??price(a.incrementalModelUsage),completeness:a.unknownCost??a.incrementalAccounting??"Missing incremental accounting"});
      }
    }
  }
  visit(runDirectory);
  const ranges=attempts.map(a=>a.priceEstimate as {usdRange?:number[]}|null).filter(p=>p?.usdRange);
  const ledger={asOf:"2026-10-13",source,usdPerMillion:rates,authentication,actualBilling:"Not measured; SDK accounting and API-equivalent estimates are not subscription invoices",attempts,
    observedSdkTotalUsd:attempts.reduce((s,a)=>s+Number(a.sdkReportedUsd??0),0),
    observedPriceEstimateUsdRange:[0,1].map(i=>ranges.reduce((s,p)=>s+(p!.usdRange![i]??0),0)),
    attemptsWithoutFinalUsage:attempts.filter(a=>a.sdkReportedUsd===null).length,
    completeness:attempts.length?"Observed amounts only; see individual attempt completeness":"No credentialed attempts in this run; credential-free blocked hooks have zero reported token usage",
    coverage:"Native accounting excludes some internal helper calls outside the query pipeline; compare provider billing separately",
    agentImplementationCosts:"Orchestrator/subagent usage is not exposed by these probe APIs and is excluded"};
  writeFileSync(join(runDirectory,"cost-ledger.json"),JSON.stringify(ledger,null,2)+"\n",{mode:0o600});return ledger;
}

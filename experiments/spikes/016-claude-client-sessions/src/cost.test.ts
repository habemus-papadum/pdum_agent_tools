import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { priceTurn, writeBrowserCostLedger } from "./cost.js";

// Public accounting fields from this spike's real four-turn browser run.
// These fixtures test accounting only, not provider compatibility.
const counts=[
  {id:"original",cost:0.0006774,input:2,output:6,read:0,write:3371},
  {id:"parallel",cost:0.0006728,input:2,output:6,read:0,write:3348},
  {id:"fork",cost:0.00013129,input:2,output:15,read:2979,write:469},
  {id:"original",cost:0.00071958,input:2,output:15,read:3448,write:0},
];
function result(c:typeof counts[number]){return {type:"result",subtype:"success",total_cost_usd:c.cost,
  modelUsage:{"claude-haiku-5-5":{canonicalModel:"claude-haiku-5-5"}},
  usage:{input_tokens:c.input,output_tokens:c.output,cache_read_input_tokens:c.read,cache_creation_input_tokens:c.write,
    cache_creation:{ephemeral_1h_input_tokens:c.write,ephemeral_5m_input_tokens:0}},
};}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"spike016-cost-"));mkdirSync(join(dir,"manager"));
  const workers=counts.map((c,i)=>({id:String(i),conversationId:c.id,startedAt:`2026-10-13T00:00:0${i}Z`}));
  writeFileSync(join(dir,"manager/workers.json"),JSON.stringify(workers));
  for(const [i,c] of counts.entries()){
    const worker=join(dir,"manager",String(i));mkdirSync(worker);
    writeFileSync(join(worker,"relay-input.ndjson"),' {"type":"user"}\n');
    writeFileSync(join(worker,"stdout.ndjson"),JSON.stringify(result(c))+"\n");
  }return dir;
}
test("public cache TTL accounting and resumed totals reconcile without charging old history twice",()=>{
  const dir=fixture();try{
    assert.deepEqual(priceTurn(result(counts[0]!))?.usdRange,[0.0006774,0.0006774]);
    const ledger=writeBrowserCostLedger(dir,"fixture",true);
    assert(Math.abs(ledger.totalSdkEstimatedUsd!-0.00152367)<1e-12);
    assert.equal(ledger.attempts[3]!.previousObservedConversationTotalUsd,0.0006774);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("missing final usage leaves aggregate unknown while preserving the observed subtotal",()=>{
  const dir=fixture();try{
    writeFileSync(join(dir,"manager/3/stdout.ndjson"),"");
    const ledger=writeBrowserCostLedger(dir,"fixture",true);
    assert.equal(ledger.totalSdkEstimatedUsd,null);
    assert.equal(ledger.attempts[3]!.sdkAllocatedUsd,null);
    assert(ledger.observedSdkSubtotalUsd>0);
    assert.match(ledger.completeness,/Incomplete/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

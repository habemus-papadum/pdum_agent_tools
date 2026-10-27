import assert from'node:assert/strict';import{readFile,writeFile}from'node:fs/promises';
const folder=new URL('../../artifacts/071-claude-sdk-replay/',import.meta.url);
const live=JSON.parse(await readFile(new URL('live.json',folder),'utf8'));
const entries=(await readFile(live.run.journalPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
const frames=Buffer.concat(entries.filter(e=>e.direction==='stdout').map(e=>Buffer.from(e.data,'base64'))).toString().trim().split('\n').map(line=>JSON.parse(line));
const results=[...new Map(frames.filter(f=>f.type==='result').map(f=>[f.uuid,f])).values()];
const rows=results.map(result=>{
  const u=result.usage;const oneHour=u.cache_creation?.ephemeral_1h_input_tokens??0;
  const created=u.cache_creation_input_tokens??0,read=u.cache_read_input_tokens??0;
  const cost=(u.input_tokens*.10+read*.01+oneHour*.20+(created-oneHour)*.125+u.output_tokens*.50)/1e6;
  assert(!result.is_error);assert(Object.keys(result.modelUsage).every(name=>name.includes('haiku')));
  return{uuid:result.uuid,usage:u,estimatedUsd:cost,nativeCumulativeUsd:result.total_cost_usd};
});
const total=rows.reduce((sum,row)=>sum+row.estimatedUsd,0);assert.equal(rows.length,3);
assert(Math.abs(total-rows.at(-1).nativeCumulativeUsd)<1e-12);
const report={date:'2026-10-26',priceSnapshot:'2026-10-17',model:'claude-haiku-5-5',rows,estimatedUsd:total,
 actualBilledUsd:null,implementationAssistantCost:null,paidRetries:0,notes:'All three inputs completed; last harness field-path assertion corrected using raw capture.'};
await writeFile(new URL('costs.json',folder),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));

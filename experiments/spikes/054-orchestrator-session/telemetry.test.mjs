import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,projectTelemetry,estimatedCost,navigationPoints } from './src/model/telemetry.ts';

test('cached tokens partition input and tools never double count model charges',()=>{
  const items=fixture('complete'), ledger=projectTelemetry(items);
  const model=items.filter(i=>i.requestId);
  assert.equal(ledger.totals.tokens,model.reduce((n,i)=>n+i.usage.input+i.usage.output,0));
  assert.equal(ledger.totals.cost,model.reduce((n,i)=>n+estimatedCost(i.usage),0));
  assert.ok(ledger.rows.filter(r=>r.item.kind==='tool').every(r=>r.cost===null));
  assert.equal(estimatedCost({input:1000,cachedInput:800,output:100}),.00136);
});
test('unknown usage contributes no invented zero quote and flags coverage',()=>{
  const partial=projectTelemetry(fixture('partial')),complete=projectTelemetry(fixture('complete'));
  assert.equal(partial.totals.knownRequests,5);assert.equal(partial.totals.requests,6);
  assert.equal(partial.rows.find(r=>r.item.id==='m3').cost,null);
  assert.ok(partial.totals.cost<complete.totals.cost);
  assert.equal(partial.totals.compactionCostKnown,false);
  assert.equal(navigationPoints(partial,'cost').find(p=>p.id==='m6').known,false);
});
test('compaction drops context without reducing cumulative usage or treating context as tokens',()=>{
  const ledger=projectTelemetry(fixture('partial'));
  const before=ledger.rows.find(r=>r.item.id==='m4'),after=ledger.rows.find(r=>r.item.id==='compact1');
  assert.equal(before.context,59000);assert.equal(after.context,16500);
  assert.equal(before.cumulativeTokens,after.cumulativeTokens);
  assert.equal(before.cumulativeCost,after.cumulativeCost);
  assert.ok(navigationPoints(ledger,'context').find(p=>p.id==='compact1').position<navigationPoints(ledger,'context').find(p=>p.id==='m4').position);
});
test('duplicates and invalid cache accounting fail instead of inflating totals',()=>{
  const rows=fixture('complete');assert.throws(()=>projectTelemetry([...rows,rows[1]]),/Duplicate/);
  assert.throws(()=>estimatedCost({input:1,cachedInput:2,output:0}),/partition/);
});

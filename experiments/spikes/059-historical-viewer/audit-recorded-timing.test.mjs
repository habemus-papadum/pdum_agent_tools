import test from 'node:test';import assert from 'node:assert/strict';import {auditRecordedTiming}from'./audit-recorded-timing.mjs';
const event=(method,monotonic,item,client='A')=>({client,monotonic,message:{method,params:{threadId:'t',turnId:'u',item,turn:{id:'u'}}}});
test('reported duration, observed interval and late completion remain distinct',()=>{
 const r=auditRecordedTiming([event('item/started',1,{id:'i',type:'commandExecution'}),event('turn/completed',2),event('item/completed',4,{id:'i',type:'commandExecution',durationMs:2500,status:'completed'})]);
 assert.equal(r.items[0].reportedDurationMs,2500);assert.equal(r.items[0].receiptSpanMs,3000);assert.equal(r.items[0].completionAfterTurnMs,2000);
});
test('missing completion has no fabricated duration, and client clocks never mix',()=>{
 const r=auditRecordedTiming([event('item/started',1,{id:'i',type:'commandExecution'}),event('item/completed',9,{id:'i',type:'commandExecution',durationMs:100},'B')]);
 assert.equal(r.items.length,2);assert.equal(r.items[0].reportedDurationMs,null);assert.equal(r.items[0].receiptSpanMs,null);assert.equal(r.items[1].receiptSpanMs,null);
});

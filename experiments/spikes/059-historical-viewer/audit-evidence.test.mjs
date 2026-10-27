import test from 'node:test';
import assert from 'node:assert/strict';
import {auditDocument} from './audit-evidence.mjs';
test('image origin follows the containing tool, not only the native user role',()=>{
  const message={role:'user',content:[{type:'image',source:{type:'base64',data:'fixture'}},{type:'tool_result',content:[{type:'image',source:{type:'base64',data:'fixture'}}]}]};
  const result=auditDocument({provider:'claude',payload:{messages:[{message}]}});
  assert.deepEqual(result.images,{'user-input':1,'tool-output':1});assert.equal(message.content.length,2);
});
test('turn clocks and paginated item clocks remain separate from durations',()=>{
  const result=auditDocument({provider:'codex',payload:{thread:{turns:[{startedAt:100,completedAt:200,items:[{type:'commandExecution',durationMs:10}]},{startedAt:4000,completedAt:null,items:[]}]},itemPages:[{data:[{turnId:'t',item:{type:'agentMessage'},startedAtMs:110000,completedAtMs:120000}]}]}});
  assert.deepEqual(result.turnTimes,{startedAt:2,completedAt:1});assert.deepEqual(result.itemTimes,{durationMs:1});
  assert.deepEqual(result.pagedItemTimes,{entries:1,started:1,completed:1});assert.deepEqual(result.turnGaps,{over30Minutes:1,maxSeconds:3800});
});
test('settings on a collaboration item are not labelled parent-turn settings; text is only candidate evidence',()=>{
  const result=auditDocument({provider:'codex',payload:{thread:{turns:[{items:[{type:'collabAgentToolCall',tool:'wait',model:'fixture-model',receiverThreadIds:['child']},{type:'agentMessage',text:'Consider steering later.',phase:'commentary'}]}]}}});
  assert.deepEqual(result.turnSettings,{});assert.deepEqual(result.settingsByType,{'collabAgentToolCall:model':1});assert.equal(result.nativeSteeringFields,0);assert.equal(result.markers.steering,1);
});
test('modern subagent activity yields native child identity and its own lifecycle kind',()=>{
  const r=auditDocument({provider:'codex',payload:{thread:{turns:[{items:[{type:'subAgentActivity',kind:'started',agentThreadId:'child',model:'fixture'},{type:'subAgentActivity',kind:'completed',agentThreadId:'child'}]}]}}});
  assert.deepEqual(r.childActivities,{started:1,completed:1});assert.deepEqual(r.childTargets,['child']);assert.deepEqual(r.settingsByType,{'subAgentActivity:model':1});
});

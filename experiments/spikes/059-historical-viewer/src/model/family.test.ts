import {describe, expect, it} from 'vitest';
import {projectFamily} from './family';
import type {HistoryDocument} from './native';

const source = {kind:'fixture',method:'Synthetic family projection regression',capturedAt:'fixture',version:'test'};
const codex=(key:string,parent:string|null|undefined,items:unknown[]=[]):HistoryDocument=>({version:1,key,provider:'codex',sessionId:key,title:key,source,
  payload:{thread:{id:key,parentThreadId:parent,turns:[{id:`turn-${key}`,items}]}}});
const claude=(key:string,relation:Record<string,unknown>,messages:unknown[]=[]):HistoryDocument=>({version:1,key,provider:'claude',sessionId:'shared-session',title:key,
  source:{...source,relation:{rootSessionId:'shared-session',...relation}},payload:{messages}});
const response=(id:string,input=10)=>({message:{id,role:'assistant',model:'actor',usage:{input_tokens:input,output_tokens:2},content:[{type:'text',text:'Answer'}]}});

describe('captured family projections',()=>{
  it('keeps provider identities and Claude child keys distinct despite a shared session ID',()=>{
    const documents=[claude('main',{kind:'root'},[response('r')]),claude('child-a',{kind:'subagent',agentId:'a',parentAgentIds:[]},[response('r')]),
      claude('child-b',{kind:'subagent',agentId:'b',parentAgentIds:['a']},[response('other')])];
    const family=projectFamily(documents,{version:1,rootKey:'main'});
    expect(family.lanes.map(lane=>lane.key)).toEqual(['main','child-a','child-b']);
    expect(family.lanes[1]).toMatchObject({parentKey:null,parentStatus:'unknown'});
    expect(family.lanes[2]).toMatchObject({parentKey:'child-a',parentStatus:'resolved',parentBasis:'sdk-parent-agent'});
    expect(family.ledger.input).toBe(20); // Shared response counted once, not once per document.
    expect(family.ledger.sharedResponses).toBe(1);
    expect(family.ledger.ownership).toBe('unassigned');
    expect(family.ledger.requests[0].occurrences).toHaveLength(2);
    expect(family.ledger.cost).toBeNull();expect(family.ledger.context).toBeNull();
    expect(family.lanes[0].projection.document).toBe(documents[0]);
  });
  it('preserves partial family evidence and never upgrades an absent parent to a root',()=>{
    const family=projectFamily([codex('root',undefined),codex('child','missing'),codex('unknown',undefined)],{
      version:1,rootKey:'root',members:[codex('root',undefined),codex('missing',undefined)],
    });
    expect(family.lanes[0].parentStatus).toBe('root');
    expect(family.lanes[1]).toMatchObject({parentKey:null,parentIdentity:'missing',parentStatus:'missing'});
    expect(family.lanes[2].parentStatus).toBe('unknown');
    expect(family.missingMembers[0].key).toBe('missing');
    expect(family.stats.unresolvedParents).toBe(2);
  });
  it('resolves an exact parent-tool reference only when its owner is unambiguous',()=>{
    const tool={message:{id:'request',role:'assistant',content:[{type:'tool_use',id:'spawn-call',name:'Agent',input:{}}]}};
    const root=claude('root',{kind:'root'},[tool]),child=claude('child',{agentId:'child',parentToolUseIds:['spawn-call']});
    expect(projectFamily([root,child],{rootKey:'root'}).lanes[1]).toMatchObject({parentKey:'root',parentBasis:'native-tool-reference'});
    const inherited=claude('other',{agentId:'other'},[tool]);
    expect(projectFamily([root,inherited,child],{rootKey:'root'}).lanes[2]).toMatchObject({parentKey:null,parentStatus:'ambiguous'});
  });
  it('namespaces equal response IDs by provider and keeps unknown clocks unpositioned',()=>{
    const family=projectFamily([claude('c',{kind:'root'},[response('same')]),codex('x',undefined,[
      {id:'item',type:'agentMessage',requestId:'same',usage:{inputTokens:20,outputTokens:3},model:'actor',text:'Answer'},
    ])]);
    expect(family.ledger.requests).toHaveLength(2);expect(family.ledger.input).toBe(30);
    expect(family.stats.untimedItems).toBe(2);
    expect(family.lanes[1].stats.durationCoverage).toEqual({known:0,total:1});
  });
  it('guards unavailable/versioned bundles and records cyclic parent evidence',()=>{
    expect(projectFamily([codex('x',null)],{version:2}).available).toBe(false);
    expect(projectFamily([codex('x',null)],{available:false,reason:'Capture missing'}).lanes).toEqual([]);
    const cycle=projectFamily([codex('a','b'),codex('b','a')]);
    expect(cycle.warnings.join(' ')).toContain('Cyclic');
    expect(cycle.lanes.some(lane=>lane.parentStatus==='ambiguous')).toBe(true);
  });
});

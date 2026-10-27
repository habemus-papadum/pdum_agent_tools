import {describe, expect, it} from 'vitest';
import {projectHistory, type HistoryItem} from './native';
import {buildTimeAxis, forwardTime, inverseTime, nearestTimelineItem, timeExtent, timelineGeometry, type TimelineLane} from './timeline';

const base=()=>projectHistory({key:'fixture',provider:'codex',sessionId:'fixture',title:'Synthetic timeline regression',source:{kind:'fixture',method:'test',capturedAt:''},
  payload:{thread:{turns:[{id:'turn',items:[{id:'item',type:'agentMessage',text:'Response'}]}]}}}).items[0];
const item=(id:string,start:number|null,end:number|null,duration:number|null=null):HistoryItem=>({...base(),id,timing:{startedAtMs:start,completedAtMs:end,reportedDurationMs:duration}});
const lane=(key:string,items:HistoryItem[]):TimelineLane=>({key,items});

describe('shared family time axis',()=>{
  it('compresses only global gaps, preserving another selected lane’s busy interval',()=>{
    const lanes=[lane('parent',[item('a',0,0),item('b',100,100)]),lane('child',[item('work',25,75)])];
    const axis=buildTimeAxis(lanes,{gapThresholdMs:10});
    expect(axis.gaps.map(gap=>[gap.startMs,gap.endMs,gap.elapsedMs])).toEqual([[0,25,25],[75,100,25]]);
    expect(axis.visibleDurationMs).toBe(70);
    expect(forwardTime(axis,25)).toBeCloseTo(10/70);expect(forwardTime(axis,75)).toBeCloseTo(60/70);
    const filtered=timelineGeometry(lanes,{mode:'time',axis,include:item=>item.id==='a'});
    expect(filtered[1].positionedItems).toBe(0);expect(axis.gaps).toHaveLength(2); // Filtering did not rebuild the shared axis.
  });
  it('round trips raw time inside compressed and explicitly expanded gaps, including the final endpoint',()=>{
    const lanes=[lane('one',[item('first',1000,1010),item('last',100000,100010)])];
    const axis=buildTimeAxis(lanes,{gapThresholdMs:100});
    for(const value of [1000,1010,25000,99999,100000,100010]) expect(inverseTime(axis,forwardTime(axis,value)!)).toBeCloseTo(value,6);
    expect(forwardTime(axis,100010)).toBe(1);expect(inverseTime(axis,1)).toBe(100010);
    const expanded=buildTimeAxis(lanes,{gapThresholdMs:100,expandedGapIds:[axis.gaps[0].id]});
    expect(expanded.gaps[0]).toMatchObject({compressed:false,expanded:true,removedMs:0});
    expect(expanded.visibleDurationMs).toBe(expanded.rawDurationMs);
    expect(nearestTimelineItem(lanes[0],1,{mode:'time',axis})?.id).toBe('last');
  });
  it('unions overlapping work and preserves zero, partial endpoints and invalid clocks distinctly',()=>{
    const lanes=[lane('one',[item('a',0,60),item('unknown',null,null,1000)]),lane('two',[item('b',50,100),item('bad',20,10)])];
    const axis=buildTimeAxis(lanes,{gapThresholdMs:5});
    expect(axis.gaps).toEqual([]);expect(axis.unknownItems).toBe(2);expect(axis.invalidIntervals).toBe(1);
    expect(timeExtent(item('zero',0,0))).toMatchObject({kind:'instant',startMs:0,endMs:0});
    expect(timeExtent(item('open',5,null,100))).toMatchObject({kind:'start-only',startMs:5,endMs:5});
    expect(timeExtent(item('end',null,6))).toMatchObject({kind:'end-only',startMs:6,endMs:6});
    const geometry=timelineGeometry(lanes,{mode:'time',axis});
    expect(geometry[0].unknownItemIds).toEqual(['unknown']);expect(geometry[1].unknownItemIds).toEqual(['bad']);
  });
  it('keeps wholly unknown clocks out of time geometry and requires an explicit axis',()=>{
    const lanes=[lane('unknown',[item('u',null,null,100)])],axis=buildTimeAxis(lanes);
    expect(axis.minMs).toBeNull();expect(forwardTime(axis,12)).toBeNull();expect(inverseTime(axis,.5)).toBeNull();
    expect(timelineGeometry(lanes,{mode:'time',axis})[0]).toMatchObject({positionedItems:0,unknownItemIds:['u']});
    expect(()=>timelineGeometry(lanes,{mode:'time'})).toThrow('shared time axis');
  });
  it('uses independent lane ordinals and a bounded path/bin count for very long traces',()=>{
    const shared=base(),many=Array.from({length:10003},(_,index)=>({...shared,id:`item-${index}`}));
    const lanes=[lane('long',many),lane('short',[item('x',null,null),item('y',null,null)])];
    const geometry=timelineGeometry(lanes,{mode:'sequence',bins:120});
    expect(geometry.every(value=>value.bins.length===120&&value.paths.length===6)).toBe(true);
    expect(geometry[0].bins.at(-1)?.lastItemId).toBe('item-10002');
    expect(geometry[1].bins.at(-1)?.lastItemId).toBe('y');
    expect(nearestTimelineItem(lanes[0],1,{mode:'sequence'})?.id).toBe('item-10002');
    expect(nearestTimelineItem(lanes[1],1,{mode:'sequence'})?.id).toBe('y');
    expect(many).toHaveLength(10003);
  });
});

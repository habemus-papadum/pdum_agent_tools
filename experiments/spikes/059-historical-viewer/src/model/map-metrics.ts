/** Small navigator overlays. Values retain their scope; no cost or occupancy is invented. */
import {filterItems, type HistoryItem} from './native';
import type {FamilyLane} from './family';
import {failed} from './presentation';
import {forwardTime, timeExtent, type TimeAxis} from './timeline';
export interface MetricOptions {track:string;mode:'sequence'|'time';axis:TimeAxis;query?:string;kind?:string;bins?:number;}
export function modelColorIndex(model:string):number {let hash=0;for(const character of model)hash=(Math.imul(hash,31)+character.charCodeAt(0))>>>0;return hash%5;}
export function metricView(lanes:readonly FamilyLane[],options:MetricOptions){
  const size=options.bins??160;let maximum=0;
  const models=[...new Set(lanes.flatMap(lane=>lane.items.filter(item=>item.modelScope==='actor-response'&&item.model).map(item=>item.model!)))].sort();
  const series=lanes.map(lane=>{
    const requests=new Map(lane.projection.ledger.requests.map(request=>[request.itemIds[0],request]));
    const bins=new Map<string,{index:number;value:number;model:string|null}>();
    let known=0,positioned=0,included=0;
    lane.items.forEach((item,index)=>{
      if(!filterItems([item],options.query??'',options.kind??'all').length)return;included++;
      let value:number|null=null,model:string|null=null;
      if(options.track==='errors')value=failed(item)?1:null;
      if(options.track==='duration')value=item.timing.reportedDurationMs;
      if(options.track==='model'&&item.modelScope==='actor-response'&&item.model){model=item.model;value=1;}
      if(options.track==='tokens'){
        const usage=requests.get(item.id)?.usage;
        if(usage){const values=lane.entry.provider==='claude'?[usage.input,usage.cachedInput,usage.cacheCreation,usage.output]:[usage.input,usage.output];
          const present=values.filter((n):n is number=>n!==null);if(present.length)value=present.reduce((sum,n)=>sum+n,0);}
      }
      if(value===null)return;known++;maximum=Math.max(maximum,value);
      const extent=timeExtent(item);
      const position=options.mode==='sequence'?(lane.items.length>1?index/(lane.items.length-1):0):extent?forwardTime(options.axis,extent.startMs):null;
      if(position===null)return;positioned++;
      const bin=Math.min(size-1,Math.max(0,Math.floor(position*size))),key=`${bin}:${model??''}`,prior=bins.get(key);
      if(!prior||prior.value<value)bins.set(key,{index:bin,value,model});
    });
    return {key:lane.key,known,positioned,included,bins:[...bins.values()]};
  });
  return {track:options.track,maximum,models,series:series.map(lane=>{
    const groups=new Map<string,string[]>();
    for(const bin of lane.bins){const category=options.track==='model'?`model-${modelColorIndex(bin.model!)}`:options.track;
      const width=options.track==='duration'||options.track==='tokens'?8+80*Math.log1p(bin.value)/Math.log1p(Math.max(1,maximum)):88;
      const commands=groups.get(category)??[];commands.push(`M6 ${ (bin.index/size*600).toFixed(2)}h${width.toFixed(2)}v${Math.max(.8,600/size-.5).toFixed(2)}h-${width.toFixed(2)}Z`);groups.set(category,commands);}
    return {...lane,paths:[...groups].map(([kind,commands])=>({kind,path:commands.join('')}))};
  })};
}
/** Only explicit elapsed measurements receive a default duration badge. */
export function durationMeaning(item:HistoryItem){
  if(item.timing.reportedDurationMs===null)return null;
  return item.operation?.kind==='sleep'?'Reported wait':'Reported tool elapsed';
}

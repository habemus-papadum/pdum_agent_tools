import {agentToolkit, cell, hotCellGraph, registerStandardTools} from '@habemus-papadum/aiui-viz';
import {profiles} from './journey';
import {appScope, flow, selected, updates} from './store';
export const graph = hotCellGraph(appScope.name, () => {
  /** Inventory maintains profile identity while an authentication fixture changes. */
  const inventory = cell(()=>updates.get(), changes=>profiles.map(p=>changes[p.id]??p),{scope:appScope,equals:(a,b)=>a.length===b.length&&a.every((p,i)=>p===b[i])});
  /** Selected detail is independent of the frozen in-progress journey. */
  const detail = cell(()=>({id:selected.get(),rows:inventory()}), ({id,rows})=>rows.find(p=>p.id===id)!,{scope:appScope});
  /** Journey projection is shared by buttons, keyboard actions and the toolkit. */
  const journey = cell(()=>({value:flow.get()}), ({value})=>({flow:value}),{scope:appScope});
  return {inventory,detail,journey};
}, import.meta.hot);
if(import.meta.hot) import.meta.hot.accept();
export const kit=agentToolkit(appScope.name,{brief:'Fictional profile authentication journeys. Inspect machines/profiles/agents, authenticate, continue, choose-timing, open-sign-in, complete-sign-in, test-access and back-to-profiles. Study controls inject outcomes and agents-idle. No provider IO. Workforce, Bedrock, remote handoff and running-agent policy are exploratory.'});
registerStandardTools(kit);
kit.registerReporter('authentication',()=>({simulation:true,profiles:graph().inventory.latest(),selected:selected.get(),flow:flow.get()}));

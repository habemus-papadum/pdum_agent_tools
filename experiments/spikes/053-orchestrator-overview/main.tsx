import { render } from '@solidjs/web';
import { PageBoundary } from '@habemus-papadum/aiui-viz';
import { whenReady } from '@habemus-papadum/aiui-viz/testing';
import { CommandPalette } from '../055-orchestrator-mock-lab/shared/CommandPalette';
import { mountDock } from '../055-orchestrator-mock-lab/shared/dock';
import { graph } from './graph';
import { groupValue, summarize } from './model.mjs';
import * as s from './store';
import { App } from './ui/App';
import './style.css';

const commands = [
  { id:'next', icon:'↓', group:'Agents', label:'Next presented agent', description:'Move forward without wrapping; skip collapsed or hidden groups.', key:'j', run:()=>s.invoke('move-selection',{direction:1}) },
  { id:'previous', icon:'↑', group:'Agents', label:'Previous presented agent', description:'Move backward without wrapping; skip collapsed or hidden groups.', key:'k', run:()=>s.invoke('move-selection',{direction:-1}) },
  { id:'layout', icon:'▦', group:'View', label:'Switch grid / list', key:'l', run:()=>s.setControl(s.layout,s.layout.get()==='cards'?'list':'cards') },
  { id:'sort', icon:'↕', group:'View', label:'Cycle within-group sort', key:'s', run:()=>s.setControl(s.sort,['attention','recent','name'][(['attention','recent','name'].indexOf(s.sort.get())+1)%3]) },
  { id:'group', icon:'▥', group:'Groups', label:'Cycle grouping dimension', key:'g', run:()=>s.setControl(s.group,['','status','host','cwd','project','provider'][(['','status','host','cwd','project','provider'].indexOf(s.group.get())+1)%6]) },
  { id:'clear', icon:'⊘', group:'Filters', label:'Clear search and all chart filters', description:'Grouping and presentation settings remain.', key:'r', run:()=>s.invoke('clear-filters') },
  { id:'toggle-selected', icon:'▸', group:'Groups', label:'Toggle selected agent’s group', description:'Presentation only; query totals stay unchanged.', key:'x', enabled:()=>!!s.group.get() && !!s.selected(), run:()=>s.invoke('toggle-selected-group') },
  { id:'search', icon:'⌕', group:'View', label:'Focus search', key:'/', run:()=>document.getElementById('search')?.focus() },
  { id:'filters', icon:'☷', group:'View', label:'Toggle filters and Mosaic charts', key:'f', run:()=>s.setControl(s.filtersOpen,!s.filtersOpen.get()) },
  { id:'inspector', icon:'◧', group:'View', label:'Toggle selected agent inspector', key:'i', run:()=>s.setControl(s.inspectorOpen,!s.inspectorOpen.get()) },
  { id:'tiny', icon:'⠿', group:'Density', label:'Tiny glyphs', key:'1', run:()=>s.setControl(s.density,'tiny') },
  { id:'tile', icon:'▦', group:'Density', label:'Compact tiles', key:'2', run:()=>s.setControl(s.density,'tile') },
  { id:'card', icon:'▤', group:'Density', label:'Activity cards', key:'3', run:()=>s.setControl(s.density,'card') },
  { id:'detail', icon:'▣', group:'Density', label:'Detailed cards', key:'4', run:()=>s.setControl(s.density,'detail') },
  { id:'collapse', icon:'⊟', group:'Groups', label:'Collapse all groups', key:'c', enabled:()=>!!s.group.get(), run:()=>s.invoke('collapse-all') },
  { id:'expand', icon:'⊞', group:'Groups', label:'Expand all groups', key:'e', enabled:()=>!!s.group.get(), run:()=>s.invoke('expand-all') },
  { id:'show-all', icon:'▥', group:'Groups', label:'Show every group', key:'a', enabled:()=>s.focusedValue()!==null, run:()=>s.invoke('show-all-groups') },
  { id:'only-selected', icon:'◎', group:'Groups', label:'Only the selected agent’s group', description:'Presentation focus only; query counts and cost remain unchanged.', key:'o', enabled:()=>!!s.group.get() && !!s.selected(), run:()=>s.invoke('focus-group',{value:groupValue(s.selected(),s.group.get())}) },
  { id:'mock', icon:'⚙', group:'Mock', label:'Toggle fixture controls', key:'m', run:()=>s.invoke('toggle-mock') },
];
render(()=><PageBoundary name="agent overview"><App/><CommandPalette scope={s.appScope.name} commands={commands}/></PageBoundary>,document.getElementById('root')!);
mountDock();

function snapshot() {
  const result = graph().query.latest();
  return structuredClone({ agents:s.inventory.get(), selectedId:s.selectedId.get(), detail:s.detail.get(), layout:s.layout.get(), density:s.density.get(), inspectorOpen:s.inspectorOpen.get(), fixtureCount:s.inventory.get().length, filters:s.filtersSnapshot(), summary:summarize(s.inventory.get()), filteredSummary:summarize(result?.agents||[]), groups:result?.groups||[], visibleIds:(result?.agents||[]).map(a=>a.id), facets:result?.facets||{}, engine:result?.engine||'loading', busy:graph().query.loading(), error:graph().query.error() ? String(graph().query.error()) : null, step:s.step.get(), collapsed:s.collapsed.get(), focusedGroup:s.focusedGroup.get(), cellState:graph().query.state() });
}
async function idle() { await whenReady(graph().query,{timeoutMs:30000}); return snapshot(); }
async function mutate(name:string,args:Record<string,unknown>={}) { await s.invoke(name,args); return idle(); }
async function setFilters(values:Record<string,unknown>) {
  for (const field of ['provider','host','status']) if (field in values) await s.invoke('filter-category',{field,value:values[field]});
  if ('query' in values) s.setControl(s.search,values.query);
  if ('group' in values) s.setControl(s.group,values.group);
  if ('sort' in values) s.setControl(s.sort,values.sort);
  return idle();
}
Object.assign(window,{mockOverview:Object.freeze({
  state:snapshot,idle,select:(id:string)=>s.invoke('select-agent',{id}),scenario:(scenario:string)=>mutate('simulate',{scenario}),reset:()=>mutate('reset-mock'),density:(value:string)=>s.setControl(s.density,value),inspector:(value:boolean)=>s.setControl(s.inspectorOpen,value),count:(count:number)=>mutate('fixture-count',{count}),filters:setFilters,details:()=>s.runtime.engine?.details(),
  collapse:(value:string)=>s.invoke('toggle-group',{value}),collapseAll:()=>s.invoke('collapse-all'),expandAll:()=>s.invoke('expand-all'),focusGroup:(value:string)=>s.invoke('focus-group',{value}),showAllGroups:()=>s.invoke('show-all-groups'),
})});
s.kit.registerReporter('overview',()=>{
  const result=graph().query.latest();
  return { meaning:'Summary only; full fixture records remain available through SQL and window.mockOverview.state(). No source data is truncated.',
    summary:summarize(s.inventory.get()),filteredSummary:summarize(result?.agents||[]),filters:s.filtersSnapshot(),
    selected:s.selected()?{id:s.selected()!.id,name:s.selected()!.name}:null,groups:result?.groups||[],
    sampleIds:(result?.agents||[]).slice(0,12).map(agent=>agent.id),sampleLimit:12,availableCount:result?.agents.length||0,
    cellState:graph().query.state(),error:graph().query.error()?String(graph().query.error()):null };
});

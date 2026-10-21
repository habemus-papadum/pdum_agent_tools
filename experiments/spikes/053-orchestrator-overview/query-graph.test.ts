import { describe, expect, test } from 'vitest';
import { scope } from '@habemus-papadum/aiui-viz';
import { cellHarness, tick, whenReady } from '@habemus-papadum/aiui-viz/testing';
import { createSignal } from 'solid-js';
import { buildQueryGraph } from './query-graph';
import { createAgents } from './model.mjs';
import type { QueryResult } from './store';

function fixture() {
  const [agents, setAgents] = createSignal(createAgents());
  const [search, setSearch] = createSignal('');
  const [group, setGroup] = createSignal('');
  const [sort, setSort] = createSignal('attention');
  const [revision, setRevision] = createSignal(0);
  const calls: { filters: string[]; queries: { group: string; sort: string }[]; inventory: number[]; accepted: string[] } = {filters:[],queries:[],inventory:[],accepted:[]};
  let rows = createAgents();
  let delay: null | (() => Promise<void>) = null;
  const h = cellHarness(() => buildQueryGraph({
    scope:scope(`overview-query-test-${crypto.randomUUID()}`),
    agents, search, group, sort, selectionRevision:revision,
    engine:async()=>({
      setFilters:({query})=>{calls.filters.push(query);},
      setAgents:async next=>{rows=next;calls.inventory.push(next.length);},
      snapshotQuery:async options=>{calls.queries.push(options); const snapshot=rows; if(delay) await delay(); return {agents:snapshot,groups:[],facets:{},engine:`query:${options.group}:${options.sort}`};},
    }),
    schedule:work=>work(),
    accept:result=>calls.accepted.push(result.engine),
  }));
  return {...h,calls,setAgents,setSearch,setGroup,setSort,setRevision,setDelay:(next:typeof delay)=>{delay=next;}};
}

describe('overview async cell graph',()=>{
  test('tracks search, sort, group, inventory and external selection without rewriting categories',async()=>{
    const h=fixture();
    try{
      await whenReady(h.cells.query);
      h.setSearch('transport'); await whenReady(h.cells.query); expect(h.calls.filters.at(-1)).toBe('transport');
      const writes=h.calls.filters.length;
      h.setGroup('host'); await whenReady(h.cells.query); expect(h.calls.queries.at(-1)?.group).toBe('host');
      h.setSort('name'); await whenReady(h.cells.query); expect(h.calls.queries.at(-1)?.sort).toBe('name');
      h.setAgents(createAgents(500)); expect((await whenReady(h.cells.query)).agents).toHaveLength(500);
      const reads=h.calls.queries.length; h.setRevision(v=>v+1); await whenReady(h.cells.query); expect(h.calls.queries.length).toBeGreaterThan(reads);
      expect(h.calls.filters).toHaveLength(writes);
    }finally{h.dispose();}
  });
  test('late superseded query cannot publish into current state',async()=>{
    const h=fixture();
    try{
      await whenReady(h.cells.query);
      let release!:()=>void; const pending=new Promise<void>(resolve=>{release=resolve;});
      h.setDelay(()=>pending); h.setGroup('host'); await tick(); await tick();
      h.setDelay(null); h.setGroup('provider'); await tick(); release();
      const result=await whenReady(h.cells.query);
      expect(result.engine).toBe('query:provider:attention');
      expect(h.calls.accepted).not.toContain('query:host:attention');
    }finally{h.dispose();}
  });
});

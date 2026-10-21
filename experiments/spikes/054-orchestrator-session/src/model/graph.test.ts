// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {cellHarness,resetControlSurface,whenReady} from '@habemus-papadum/aiui-viz/testing';
import {graph} from './graph';
import {metric,source,scenario,usageCoverage} from './store';
afterEach(()=>resetControlSurface());

it('ledger and downstream navigator follow usage coverage independently',async()=>{
  const h=cellHarness(()=>graph());
  try{
    expect((await whenReady(h.cells.ledger)).totals.knownRequests).toBe(5);
    usageCoverage.set('complete');
    expect((await whenReady(h.cells.ledger)).totals.cost).toBeCloseTo(.18876,10);
    expect((await whenReady(h.cells.navigation)).find(p=>p.id==='m3')?.known).toBe(true);
  }finally{h.dispose();}
});
it('metric changes navigation meaning without altering request accounting',async()=>{
  const h=cellHarness(()=>graph());
  try{
    const cost=(await whenReady(h.cells.ledger)).totals.cost;
    metric.set('context');
    const context=await whenReady(h.cells.navigation);
    expect(context.find(p=>p.id==='compact1')?.value).toBe(16500);
    expect(context.find(p=>p.id==='m3')?.value).toBeNull();
    metric.set('tokens');
    expect((await whenReady(h.cells.navigation)).at(-1)?.value).toBe(141920);
    expect((await whenReady(h.cells.ledger)).totals.cost).toBe(cost);
  }finally{h.dispose();}
});
it('source projection responds to both version and scenario without phantom fallback',async()=>{
  const h=cellHarness(()=>graph());
  try{
    expect((await whenReady(h.cells.sourceView)).version).toBe('fixture:retry-v1');
    scenario.set('changed');
    expect((await whenReady(h.cells.sourceView)).version).toBe('fixture:retry-v1');
    source.set('current');
    expect((await whenReady(h.cells.sourceView)).version).toBe('fixture:retry-v2');
    scenario.set('missing');
    expect((await whenReady(h.cells.sourceView)).available).toBe(false);
    source.set('captured');
    expect((await whenReady(h.cells.sourceView)).available).toBe(true);
  }finally{h.dispose();}
});

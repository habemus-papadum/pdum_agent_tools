// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {flush} from 'solid-js';
import {cellHarness,resetControlSurface,whenReady} from '@habemus-papadum/aiui-viz/testing';
import {graph} from './graph';
import * as s from './store';
afterEach(()=>{flush(()=>s.reset.run());resetControlSurface();});
it('inventory and selected detail recompute without retargeting a pending journey',async()=>{
  const h=cellHarness(()=>graph());try{
    expect((await whenReady(h.cells.inventory)).length).toBe(7);
    expect((await whenReady(h.cells.detail)).id).toBe('atlas/research');
    flush(()=>s.start.run());expect((await whenReady(h.cells.journey)).flow?.profile.id).toBe('atlas/research');
    s.selected.set('remote/review');expect((await whenReady(h.cells.detail)).id).toBe('remote/review');
    expect((await whenReady(h.cells.journey)).flow?.profile.id).toBe('atlas/research');
    flush(()=>s.proceed.run());expect((await whenReady(h.cells.journey)).flow?.step).toBe('timing');
    flush(()=>s.chooseTiming.run({timing:'idle'}));await whenReady(h.cells.journey);
    flush(()=>s.settleAgents.run());expect((await whenReady(h.cells.journey)).flow?.step).toBe('connect');
    expect((await whenReady(h.cells.inventory))[0].agents[0].state).toBe('idle');
    expect((await whenReady(h.cells.detail)).id).toBe('remote/review');
    flush(()=>s.signIn.run());await whenReady(h.cells.journey);flush(()=>s.complete.run());await whenReady(h.cells.journey);
    expect((await whenReady(h.cells.inventory))[0].expiry).toBeNull();
    expect((await whenReady(h.cells.detail)).auth).toBe('missing');
    flush(()=>s.finish.run());expect((await whenReady(h.cells.detail)).id).toBe('atlas/research');
  }finally{h.dispose();}
});
it('method and draft controls are frozen by Continue and access check uses the chosen outcome',async()=>{
  const h=cellHarness(()=>graph());try{
    s.selected.set('atlas/writing');await whenReady(h.cells.detail);flush(()=>s.start.run());await whenReady(h.cells.journey);
    flush(()=>{s.method.set('api-key');s.apiKeyEnv.set('TEAM_PROVIDER_KEY');s.sourceLogin.set('Research login');s.awsSource.set('role');s.scenario.set('success');});
    flush(()=>s.proceed.run());const f=(await whenReady(h.cells.journey)).flow!;
    expect(f.method).toBe('api-key');expect(f.draft).toEqual({apiKeyEnv:'TEAM_PROVIDER_KEY',source:'Research login',awsSource:'role'});
    flush(()=>s.complete.run());await whenReady(h.cells.journey);flush(()=>s.accessOutcome.set('denied'));flush(()=>s.validateAccess.run());
    expect((await whenReady(h.cells.journey)).flow?.access).toBe('denied');
    expect((await whenReady(h.cells.detail)).auth).toBe('available');
  }finally{h.dispose();}
});

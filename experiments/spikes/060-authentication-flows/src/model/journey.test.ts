import {expect,it} from 'vitest';
import {agentsBecameIdle,cancel,complete,configure,methodsFor,openBrowser,prepare,profiles,resultProfile,schedule,validate} from './journey';
const draft={apiKeyEnv:'TEAM_PROVIDER_KEY',source:'Operator login',awsSource:'sso' as const};
it('methods vary by profile family without changing profile identity',()=>{
  for(const profile of profiles) for(const method of methodsFor(profile)) {
    const next=configure(prepare(profile,1),method,draft,'success');
    expect(next.profile.id).toBe(profile.id);
    expect(next.profile.host).toBe(profile.host);
  }
  expect(()=>configure(prepare(profiles[0],1),'bedrock',draft,'success')).toThrow();
});
it('wait for idle keeps the attempt pending and does not claim background jobs stopped',()=>{
  let f=configure(prepare(profiles[0],1),'native',draft,'success');
  expect(f.step).toBe('timing'); expect(complete(f)).toBe(f);
  f=schedule(f,'idle');expect(f.step).toBe('queued');expect(complete(f)).toBe(f);
  f=agentsBecameIdle(f);expect(f.step).toBe('connect');
  expect(f.profile.agents.every(a=>a.state==='idle')).toBe(true);
  expect(f.profile.agents[1].background).toBe('Test runner');
  expect(profiles[0].agents[0].state).toBe('working');
});
it('authentication and access are separate; a denied access check preserves sign-in evidence',()=>{
  let f=configure(prepare(profiles[1],1),'native',draft,'success');
  expect(complete(f)).toBe(f); f=complete(openBrowser(f));
  expect(f.step).toBe('done'); expect(f.access).toBe('untested');
  f=validate(f,'denied');expect(f.access).toBe('denied');
  expect(resultProfile(f)?.auth).toBe('signed-in');expect(resultProfile(f)?.expiry).toBeNull();
});
it('freezes method, target and outcome even when the next draft changes',()=>{
  const p=structuredClone(profiles[1]);const d={...draft};
  const f=configure(prepare(p,1),'api-key',d,'success');p.host='workbench.remote';d.apiKeyEnv='NEW_KEY';
  expect(f.profile.host).toBe('atlas.local');expect(f.draft.apiKeyEnv).toBe('TEAM_PROVIDER_KEY');
  expect(configure(f,'native',draft,'failure')).toBe(f);
});
it('cancel before dispatch is distinct from losing observation after remote dispatch',()=>{
  const f=prepare(profiles[3],1);expect(cancel(f).step).toBe('cancelled');
  const queued=schedule(configure(f,'native',draft,'success'),'idle');expect(cancel(queued).step).toBe('cancelled');
  const sent=schedule(configure(f,'native',draft,'success'),'now');expect(cancel(sent).step).toBe('unknown');
});
it.each(['expired','failure','connection-lost'] as const)('keeps %s terminal without updating a profile or retrying',outcome=>{
  const f=complete(openBrowser(configure(prepare(profiles[1],1),'native',draft,outcome)));
  expect(f.step).toBe({expired:'expired',failure:'failed','connection-lost':'unknown'}[outcome]);
  expect(resultProfile(f)).toBeNull();expect(complete(f)).toBe(f);
});

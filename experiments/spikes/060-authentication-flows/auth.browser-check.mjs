/** Run in the served page. Exercises fixture actions only, never provider operations. */
export async function runAuthBrowserChecks() {
  const s=await import('./src/model/store.ts');
  const {graph}=await import('./src/model/graph.ts');
  const {profiles,methodsFor,usesBrowser}=await import('./src/model/journey.ts');
  const checks=[];
  const assert=(name,condition)=>{if(!condition)throw new Error(name);checks.push(name);};
  const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const run=async(action,args)=>{await action.run(args);await settle();};
  const select=async(id)=>{s.selected.set(id);await settle();};
  for(const profile of profiles) for(const method of methodsFor(profile)) {
    await run(s.reset);await select(profile.id);await run(s.start);s.method.set(method);await settle();await run(s.proceed);
    if(s.flow.get().step==='timing')await run(s.chooseTiming,{timing:'now'});
    if(usesBrowser(s.flow.get()))await run(s.signIn);
    await run(s.complete);
    assert(`${profile.id}/${method} returns to same profile`,s.flow.get().step==='done'&&s.flow.get().profile.id===profile.id&&s.flow.get().access==='untested');
    assert(`${profile.id}/${method} updates only target`,Object.keys(s.updates.get()).join()===profile.id);
    await run(s.finish);assert(`${profile.id}/${method} off-flow returns to inventory`,s.flow.get()===null&&document.querySelector('.auth-profile-detail'));
  }
  await run(s.reset);await run(s.start);await run(s.proceed);await run(s.chooseTiming,{timing:'idle'});
  assert('wait remains queued without a study event',s.flow.get().step==='queued');
  await run(s.settleAgents);
  assert('idle leaves background work visible',s.flow.get().profile.agents.some(a=>a.background)&&document.body.textContent.includes('background'));
  await run(s.signIn);await run(s.complete);s.accessOutcome.set('denied');await settle();await run(s.validateAccess);
  assert('model denial remains separate from successful authentication',s.flow.get().step==='done'&&s.flow.get().access==='denied');
  for(const outcome of ['expired','failure','connection-lost']) {
    await run(s.reset);await select('remote/review');s.scenario.set(outcome);await run(s.start);await run(s.proceed);await run(s.signIn);await run(s.complete);
    assert(`${outcome} keeps profile unchanged`,Object.keys(s.updates.get()).length===0&&s.flow.get().step!== 'done');
  }
  await run(s.reset);await select('remote/review');await run(s.start);await run(s.proceed);await run(s.cancel);
  assert('stop watching does not claim remote cancellation',s.flow.get().step==='unknown');
  await run(s.reset);await run(s.start);await select('remote/review');
  assert('selection cannot retarget open journey',s.flow.get().profile.id==='atlas/research');
  await run(s.reset);
  assert('inventory exposes actual profile hierarchy',graph().inventory.latest()?.length===7&&document.querySelectorAll('.auth-machine').length===2);
  assert('no horizontal overflow',document.documentElement.scrollWidth===document.documentElement.clientWidth);
  assert('no page boundary fault',!document.querySelector('.aiui-page-fault'));
  return {passed:checks.length,checks,width:innerWidth,height:innerHeight};
}

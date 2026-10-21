/** Run in the actual Vite browser page. Uses registered tools; no provider calls. */
export async function runSessionBrowserChecks() {
  const checks=[];
  const check=(name,passed,detail)=>{checks.push({name,passed:Boolean(passed),...(detail===undefined?{}:{detail})});};
  const tick=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const kit=window['__orchestrator-session'];
  const call=async(name,args)=>{const result=await kit.call(name,args);await tick();return result;};
  const set=(name,value)=>call('set',{name:`orchestrator-session/${name}`,value});
  await call('reset');
  const report=await call('report',{format:'full'});
  check('three actual scoped cells ready',report.cells.length===3&&report.cells.every(c=>c.name.startsWith('orchestrator-session/')&&c.state==='ready'));
  check('controls and actions are registered with source locations',report.controls.some(c=>c.name==='orchestrator-session/metric'&&c.loc)&&report.actions.some(a=>a.name==='orchestrator-session/navigate'));
  check('known request subtotal and cache partition',report.session.telemetry.cost===.17296&&report.session.telemetry.tokens===141920&&report.session.telemetry.cachedInput===89000);
  check('coverage excludes one request and compaction charge',report.session.telemetry.knownRequests===5&&report.session.telemetry.requests===6&&!report.session.telemetry.compactionCostKnown);
  await set('usageCoverage','complete');
  check('coverage control recalculates ledger cell',window.mockSession.telemetry.totals.knownRequests===6&&Math.abs(window.mockSession.telemetry.totals.cost-.18876)<1e-10);
  await set('metric','context');
  const before=window.mockSession.telemetry.rows.find(r=>r.item.id==='m4');
  const after=window.mockSession.telemetry.rows.find(r=>r.item.id==='compact1');
  check('compaction lowers context without subtracting usage',before.context===59000&&after.context===16500&&before.cumulativeTokens===after.cumulativeTokens);
  check('metric changes actual navigator rendering',document.querySelector('.nav-settings').textContent.includes('Context occupancy'));
  await set('navigator','rail');
  check('rail placement rendered',Boolean(document.querySelector('.navigator.rail'))&&!document.querySelector('.navigator.top'));
  await call('navigate',{itemId:'t3'});
  const chat=document.querySelector('#conversation-scroll'),item=document.querySelector('#item-t3');
  check('navigation scrolls selected failure near viewport top',window.mockSession.state.selectedItem==='t3'&&Math.abs(item.getBoundingClientRect().top-chat.getBoundingClientRect().top-12)<3);
  check('failed tool has diagnostic attribution',item.textContent.includes('exit 1')&&item.textContent.includes('no separate model charge'));
  const position=chat.scrollTop;
  await call('open-source');
  check('real AIUI Lens opens via registered action',Boolean(document.querySelector('.session-source-detail.aiui-lens-panel')));
  await call('select-lines',{start:7,end:12});await set('comment','Preserve the original abort reason.');await set('prompt','Add the regression test.');
  window.mockSession.pinLens();await tick();
  check('pin preserves selection and comment',window.mockSession.state.pinned&&window.mockSession.state.selection.join(',')==='7,12'&&window.mockSession.state.comment==='Preserve the original abort reason.');
  check('pin preserves conversation scroll',Math.abs(chat.scrollTop-position)<3,{before:position,after:chat.scrollTop});
  window.mockSession.unpinLens();await tick();window.mockSession.closeLens();await tick();
  check('unpin/close retains draft and selection',window.mockSession.state.prompt==='Add the regression test.'&&window.mockSession.state.selection.join(',')==='7,12');
  await call('add-excerpt');await set('deliveryMode','steer');await call('submit');await set('prompt','Edited after submission');
  check('submitted prompt/excerpt snapshot immutable',window.mockSession.state.receipt.submission.text==='Add the regression test.'&&window.mockSession.state.receipt.submission.excerpts[0].comment==='Preserve the original abort reason.');
  await call('advance-receipt');check('accepted differs from applied',window.mockSession.state.receipt.stage==='queued');
  await call('advance-receipt');check('steer applied within same target turn',window.mockSession.state.receipt.stage==='applied'&&window.mockSession.state.receipt.submission.targetTurn==='turn-12');
  for(const [mode,scenario,wanted] of [['queue','normal','turn-started'],['steer','turn-ended','not-applied'],['steer','rejected','rejected'],['queue','unknown','unknown']]) {
    await call('reset');await set('scenario',scenario);await set('prompt','Keep the reason');await set('deliveryMode',mode);await call('submit');await call('advance-receipt');if(scenario==='normal')await call('advance-receipt');
    check(`${mode}/${scenario} preserves explicit outcome`,window.mockSession.state.receipt.stage===wanted);
  }
  const unknownId=window.mockSession.state.receipt.submission.id;await call('advance-receipt');check('unknown receipt never auto-retries',window.mockSession.state.receipt.stage==='unknown'&&window.mockSession.state.receipt.submission.id===unknownId);
  await call('reset');await call('open-source');await call('select-lines',{start:7,end:12});await set('source','current');await set('scenario','changed');
  let rejected=false;try{await call('add-excerpt');}catch{rejected=true;}
  check('changing source invalidates old selection for attachment',rejected);
  await call('select-lines',{start:13,end:13});await call('add-excerpt');
  check('current source excerpt records changed content',window.mockSession.state.excerpts[0].contentVersion==='fixture:retry-v2'&&window.mockSession.state.excerpts[0].text.includes('throwIfAborted'));
  await set('scenario','missing');check('missing host file is explicit',document.querySelector('.source-panel').textContent.includes('not found'));
  const sources=await call('sources',{filter:'054-orchestrator-session/src/model',limit:4});
  check('source processor lists actual app sources',sources.files.some(file=>file.endsWith('/store.ts')));
  const source=await call('source',{file:'../054-orchestrator-session/src/model/store.ts',from:1,to:8});
  check('source inspection resolves compiled location',source.available!==false&&JSON.stringify(source).includes('orchestrator-session'));
  window.mockSession.closeLens();await call('reset');
  check('desktop composer remains anchored',Math.abs(document.querySelector('#composer').getBoundingClientRect().bottom-innerHeight)<2);
  check('no horizontal page overflow',document.documentElement.scrollWidth<=innerWidth+1);
  return {checks,passed:checks.filter(c=>c.passed).length,total:checks.length,allPassed:checks.every(c=>c.passed),viewport:[innerWidth,innerHeight]};
}

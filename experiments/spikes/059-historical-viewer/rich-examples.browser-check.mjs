/** Exercise actual captured message bookmarks. Results contain counts/booleans, never native bodies or image bytes. */
export async function runRichExamplesBrowserChecks({initialOnly=false}={}) {
  const {graph}=await import('./src/model/graph.ts');
  const state=await import('./src/model/store.ts');
  const {exampleBookmarks,resolveExample}=await import('./src/model/examples.ts');
  const kit=window['__native-history'],checks=[];
  const pause=(ms=100)=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async predicate=>{const end=performance.now()+30000;while(performance.now()<end){if(predicate())return true;await pause();}return false;};
  const check=(name,passed)=>checks.push({name,passed:Boolean(passed)});
  const call=async(name,args)=>{const result=await kit.call(name,args);await pause();return result;};
  const set=(name,value)=>call('set',{name:`native-history/${name}`,value});
  const result=()=>({passed:checks.filter(c=>c.passed).length,total:checks.length,allPassed:checks.every(c=>c.passed),viewport:[innerWidth,innerHeight],checks});
  const el=id=>document.querySelector(`[data-history-item="${CSS.escape(id)}"]`);
  if(!await until(()=>graph().family.latest()?.id==='rich-messages'&&graph().projection.state()==='ready'&&graph().readerFocus.latest()?.id))throw new Error('Open this check with ?group=rich-messages; collection did not settle');
  const bundle=graph().familyResult.latest().bundle,bookmarks=exampleBookmarks(bundle.bookmarks),group=graph().family.latest();
  const initialId=new URLSearchParams(location.search).get('example')||bundle.initialBookmarkId;
  const initial=bookmarks.find(point=>point.id===initialId),resolvedInitial=initial&&resolveExample(group.lanes,initial);
  if(!resolvedInitial?.available)throw new Error('Requested initial native example is unavailable');
  await until(()=>graph().readerFocus.latest()?.id===resolvedInitial.item.id&&!!el(resolvedInitial.item.id)?.querySelector('.history-message-body'));
  check('URL chooses the exact native example',graph().projection.latest().document.key===initial.documentKey&&graph().readerFocus.latest()?.id===resolvedInitial.item.id);
  check('deep-linked native message expands automatically',el(resolvedInitial.item.id)?.dataset.expanded==='true'&&!!el(resolvedInitial.item.id)?.querySelector('.history-message-body'));
  check('deep link preserves user/assistant role and native phase',resolvedInitial.item.role===initial.role&&resolvedInitial.item.phase===initial.phase);
  check('initial message has real keyboard focus',document.activeElement===el(resolvedInitial.item.id));
  if(initial.features.includes('image'))check('deep-linked user image decodes',await until(()=>[...el(resolvedInitial.item.id)?.querySelectorAll('.history-image-trigger img')??[]].some(image=>image.complete&&image.naturalWidth>0)));
  if(initial.features.includes('math-in-prose'))check('deep-linked prose renders actual TeX',await until(()=>!!el(resolvedInitial.item.id)?.querySelector('[data-tex] .katex')));
  if(initialOnly)return {...result(),initial:initial.id};
  const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).join(',');
  const originalHash=await digest(bundle.documents),originalBookmarks=JSON.stringify(bundle.bookmarks);
  check('collection contains three independent mixed-provider captures',group.groupKind==='collection'&&group.lanes.length===3&&new Set(group.lanes.map(l=>l.entry.provider)).size===2);
  check('initial document is not assigned parenthood',group.lanes.every(l=>l.parentKey===null&&l.parentStatus!=='root'));
  await set('sourcesOpen',true);await set('inspector','closed');await set('updatesAsPills',false);await call('set-density',{level:'compact'});
  await call('leave-family');await until(()=>graph().family.latest()===null&&graph().projection.state()==='ready');
  const selector=document.querySelector('.history-family-chooser select');selector.value='rich-messages';selector.dispatchEvent(new Event('change',{bubbles:true}));
  const defaultPoint=bookmarks.find(point=>point.id===bundle.initialBookmarkId),defaultNative=resolveExample(group.lanes,defaultPoint);
  await until(()=>graph().family.latest()?.id==='rich-messages'&&graph().readerFocus.latest()?.id===defaultNative.item.id&&!!el(defaultNative.item.id)?.querySelector('.history-message-body'));
  check('explicit collection selector opens its initial native example',graph().projection.latest().document.key===defaultPoint.documentKey&&graph().readerFocus.latest()?.id===defaultNative.item.id);
  check('explicit collection selection automatically expands the prompt',el(defaultNative.item.id)?.dataset.expanded==='true'&&!!el(defaultNative.item.id)?.querySelector('.history-image-trigger'));
  check('all six review points are exposed',bookmarks.length===6&&document.querySelectorAll('[data-example]').length===6);
  check('sidebar calls them captures and states no relationship claim',document.querySelector('.history-family-meta')?.textContent.includes('3 captures')&&document.querySelector('.history-family-notes')?.textContent.includes('no parent/child relationships'));
  check('capture labels are descriptive rather than fake Main/Agent labels',[...document.querySelectorAll('.history-actor-name b')].every(node=>!/^(Main|Agent \d+)$/.test(node.textContent)));
  check('every review point has a stable direct link',[...document.querySelectorAll('.history-example-row>a')].every(link=>{const url=new URL(link.href);return url.searchParams.get('group')==='rich-messages'&&bookmarks.some(point=>point.id===url.searchParams.get('example'));}));
  document.querySelector('.history-example-gaps summary')?.click();await pause();
  check('three collection coverage gaps are explicitly disclosed',bundle.relationships.coverage.gaps.length===3&&document.querySelector('.history-example-gaps')?.open&&document.querySelectorAll('.history-example-gaps p').length===3);
  const opened=[];
  for(const point of bookmarks){
    const native=resolveExample(group.lanes,point);
    if(!native.available)throw new Error('A supplied bookmark no longer resolves by native identity');
    const response=await call('open-example',{id:point.id});
    await until(()=>graph().projection.latest()?.document.key===point.documentKey&&graph().readerFocus.latest()?.id===native.item.id&&!!el(native.item.id));
    const node=el(native.item.id);opened.push(point.id);
    check(`${point.id}: resolves native identity and expands`,response.available===true&&node?.dataset.expanded==='true'&&native.item.nativeId===(point.itemId||point.uuid));
    check(`${point.id}: preserves role and phase`,native.item.role===point.role&&native.item.phase===point.phase&&node?.querySelector('.history-role b')?.textContent===(point.role==='user'?'You':'Agent'));
    check(`${point.id}: selected bookmark is explicit`,document.querySelector(`[data-example="${point.id}"]`)?.dataset.selected==='true');
    check(`${point.id}: selected message is not a tool result`,native.item.operation===null&&node?.classList.contains('history-message')&&!native.item.blocks.some(block=>block.kind==='result'));
    if(point.features.includes('image')){
      const lens=node?.querySelector('.history-image-trigger');lens?.scrollIntoView({block:'nearest'});
      check(`${point.id}: native user thumbnail decodes`,native.item.role==='user'&&native.item.blocks.some(block=>block.kind==='image'&&block.origin==='User input')&&await until(()=>[...lens?.querySelectorAll('img')??[]].some(image=>image.complete&&image.naturalWidth>0)));
    }
    if(point.features.includes('math-in-prose')){
      check(`${point.id}: prose renders TeX`,await until(()=>!!node?.querySelector('[data-tex] .katex')));
      check(`${point.id}: final versus update is visible`,node?.querySelector('.history-phase')?.textContent===(point.phase==='commentary'?'update':'final'));
    }
    check(`${point.id}: page retains horizontal bounds`,document.documentElement.scrollWidth<=innerWidth+1);
  }
  const point=bookmarks[0],original=resolveExample(group.lanes,point);
  const wrongOrdinal=resolveExample(group.lanes,{...point,ordinal:999999});
  check('bookmark navigation uses identity rather than supplied ordinal',wrongOrdinal.available&&wrongOrdinal.item.id===original.item.id);
  const wrongIdentity=resolveExample(group.lanes,{...point,itemId:'missing-native-record',uuid:'missing-native-record',ordinal:0});
  check('missing identity never falls back to ordinal',wrongIdentity.available===false);
  const priorFocus=graph().readerFocus.latest()?.id;const missing=await call('open-example',{id:'missing-example'});
  check('unknown example reports a gap without moving focus',missing.available===false&&graph().readerFocus.latest()?.id===priorFocus&&Boolean(state.exampleNotice.get()));
  await call('open-example',{id:point.id});check('valid selection clears previous example error',!state.exampleNotice.get());
  check('native documents remain unchanged after navigation',await digest(graph().familyResult.latest().bundle.documents)===originalHash);
  check('bookmark identities remain unchanged',JSON.stringify(graph().familyResult.latest().bundle.bookmarks)===originalBookmarks&&new Set(opened).size===6);
  await set('sourcesOpen',false);await set('inspector','closed');
  check('side panes can close for phone reading',!document.querySelector('.history-catalog,.history-inspector'));
  check('closed-pane reader fills available width',document.querySelector('.history-conversation').getBoundingClientRect().width>=innerWidth-1);
  check('no page fault',!document.querySelector('.aiui-page-fault'));
  const report=await kit.call('report',{format:'full'});check('all operations remain inspection-only',report.history.readOnly===true&&report.actions.every(a=>!/resume|fork|submit|delete|login/.test(a.name)));
  return {...result(),examples:opened.length,documents:bundle.documents.length};
}

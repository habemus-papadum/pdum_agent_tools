/** Focused checks of the real local app. No provider calls. Config comments are restored. */
export async function runIngestionBrowserChecks(){
 const kit=window['__ingestion-statistics'];const checks=[];
 const check=(name,value)=>{if(!value)throw new Error(name);checks.push(name);};
 const wait=async(test)=>{for(let i=0;i<100;i++){if(await test())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out waiting for real data');};
 const set=(name,value)=>kit.call('set',{name:`ingestion-statistics/${name}`,value});
 await set('view','sessions');await set('provider','all');await set('search','');
 await wait(()=>document.querySelectorAll('.ing-session-row').length>0);
 const initial=await kit.call('report',{detail:'brief'});
 check('real corpus loaded',initial.data.rows===6);
 check('known usage has unpriced coverage',initial.data.totals.cost>0&&initial.data.totals.unpriced>0);
 await set('provider','claude');await wait(()=>document.querySelectorAll('.ing-session-row').length===2);
 check('provider filter narrows actual rows',true);
 check('Claude context is not synthesized occupancy',Array.from(document.querySelectorAll('.ing-session-row')).every(el=>el.textContent.includes('context unknown')));
 await set('search','no-match-for-this-study');await wait(()=>document.querySelectorAll('.ing-session-row').length===0);
 check('empty filter remains honest',document.body.textContent.includes('No sessions match'));
 await set('search','');await set('provider','all');await set('view','analysis');
 await wait(()=>document.querySelectorAll('.ing-analysis-result tbody tr').length>0);
 check('existing question returns real SQL rows',document.querySelector('.ing-analysis-result pre')?.textContent.includes('usage_events'));
 await set('question','Q6');await wait(()=>document.querySelector('.ing-analysis-result h2')?.textContent.includes('Codex reported context'));
 check('context preset excludes Claude response-derived counters',document.querySelector('.ing-analysis-result pre')?.textContent.includes("source LIKE 'codex%'"));
 const original=await (await fetch('/__ingestion/config')).json();
 const invalid=await fetch('/__ingestion/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'sources: [not a valid source]'})});
 check('invalid native config rejected',invalid.status===400);
 check('failed save leaves current config unchanged',(await (await fetch('/__ingestion/config')).json()).text===original.text);
 try {
 const changed=await fetch('/__ingestion/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:original.text+'\n# disposable browser validation\n'})});
 check('real native YAML saved',changed.ok);
 }finally{await fetch('/__ingestion/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:original.text})});}
 check('saved config restored',(await (await fetch('/__ingestion/config')).json()).text===original.text);
 await kit.call('sync-now',{});
 const status=await (await fetch('/__ingestion/status')).json();
 check('real incremental sync completes',status.job.status==='complete');
 check('unchanged real sources skipped',status.job.summaries.reduce((n,s)=>n+(s.units.unchanged??0),0)===6);
 await set('view','sources');await wait(()=>document.body.textContent.includes('Published source provenance'));
 check('source provenance visible',document.body.textContent.includes('Published source provenance'));
 await set('view','runs');await wait(()=>document.body.textContent.includes('Recorded ingestion phases'));check('run evidence view reachable',true);
 await set('view','sessions');await set('configOpen',true);await wait(()=>!!document.querySelector('textarea'));
 check('configuration editor uses actual file',document.querySelector('textarea')?.value.includes('window_days:'));
 await set('configOpen',false);await set('question','Q1');
 check('no page horizontal overflow',document.documentElement.scrollWidth<=innerWidth);
 check('no mounted cell failures',document.querySelectorAll('.cell-error, .aiui-cell-error').length===0);
 return {passed:checks.length,checks,viewport:{width:innerWidth,height:innerHeight},providerCalls:0};
}

import assert from 'node:assert/strict';
import {mkdir,writeFile}from'node:fs/promises';
import {query}from'@anthropic-ai/claude-agent-sdk/browser';
import {query as nodeQuery}from'@anthropic-ai/claude-agent-sdk';
import {remoteProcess}from'../../../examples/claude-client/node-transport.mjs';
import {installFeedAdapter,openClient,until,InputQueue,connections}from'./client.mjs';
assert(process.argv.includes('--live'));const base=process.env.SPIKE071_URL;assert(base);
const folder=new URL('../../artifacts/071-claude-sdk-replay/',import.meta.url);await mkdir(folder,{recursive:true});
const call=async(path,body)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw Error(`HTTP${r.status}`);return r.json();};
const run=await call('/sessions',{tools:'Bash',permission:'manual',max_budget:.05,max_turns:3});
const url=base.replace('http','ws')+run.feed;const clients=[];const callbacks={a:[],b:[]};const checks=[];
installFeedAdapter({passiveReplay:true});let failure;
const handler=label=>async(name,input,options)=>new Promise(resolve=>callbacks[label].push({name,input,options,resolve}));
try {
 const a=await openClient(query,url,{canUseTool:handler('a')});clients.push(a);
 const b=await openClient(query,url,{canUseTool:handler('b')});clients.push(b);
 await a.session.applyFlagSettings({permissions:{ask:['Bash']}});
 const uuid=a.send('Use Bash exactly once to run `printf SDK_SHARED_071`. Wait for approval, then repeat exactly SDK_SHARED_071.');
 await until(()=>callbacks.a.length===1&&callbacks.b.length===1,40000);
 const first=callbacks.a[0],second=callbacks.b[0];assert.equal(first.options.requestId,second.options.requestId);
 first.resolve({behavior:'allow',updatedInput:first.input});
 await until(()=>a.messages.some(m=>m.type==='result'),40000);
 const result=a.messages.find(m=>m.type==='result');assert(!result.is_error);
 checks.push({name:'Both official SDK clients receive the same real native permission request',pass:true});
 checks.push({name:'Peer SDK callback is not automatically aborted by accepted-response echo',signalAborted:second.options.signal.aborted});
 assert.equal(second.options.signal.aborted,false);
 const accepted=await b.session.awaitControlResponse(second.options.requestId);
 assert.equal(accepted.response.behavior,'allow');
 second.resolve(null); // Native decision already observed; suppress an extra SDK write.
 await new Promise(resolve=>setTimeout(resolve,30));
 assert(!b.socket.sent.some(text=>{try{const f=JSON.parse(text);return f.type==='control_response'&&f.response.request_id===second.options.requestId;}catch{return false;}}));
 checks.push({name:'Public awaitControlResponse plus callback null resolves peer UI without an extra response',pass:true});
 await a.close();await b.close();assert((await call('/sessions/'+run.id)).running);
 let replayCallbacks=0;
 const c=await openClient(query,url,{canUseTool:async()=>{replayCallbacks++;return {behavior:'deny',message:'Historical callback unexpectedly dispatched'};}});clients.push(c);
 await until(()=>c.messages.some(m=>m.type==='result'));assert.equal(replayCallbacks,0);
 await c.session.reinitialize();
 const init=c.socket.nativeFrames.filter(x=>x.frame.type==='control_response'&&Array.isArray(x.frame.response.pending_permission_requests)).at(-1).frame.response;
 assert.equal(init.pending_permission_requests.length,0);
 checks.push({name:'New official Query replays transcript without old permission execution; reinitialize sees no pending request',pass:true});
 const input=new InputQueue();const messages=[];const errors=[];
 const native=nodeQuery({prompt:input,options:{settingSources:[],tools:[],model:'haiku',spawnClaudeCodeProcess:()=>remoteProcess(url)}});
 const drain=(async()=>{try{for await(const m of native)messages.push(m);}catch(error){errors.push(String(error));}})();
 await native.initializationResult();await native.interrupt();await until(()=>messages.some(m=>m.type==='result'));
 native.close();input.close();await drain;
 checks.push({name:'Official Node root SDK attaches via public spawn adapter, reads replay and controls same process',pass:true,errors});
 await c.close();
 const report={date:new Date().toISOString(),checks,run,url,uuid,result,reportedCostUsd:result.total_cost_usd,sdk:'0.3.296',native:'2.1.310',model:'haiku',replayCallbacks};
 await writeFile(new URL('live.json',folder),JSON.stringify(report,null,2));
 console.log(JSON.stringify({checks,runId:run.id,pid:run.pid,url,costUsd:result.total_cost_usd,browserFollowupReady:true},null,2));
}catch(error){failure=String(error);process.exitCode=1;console.error(failure);await call('/sessions/'+run.id+'/stop',{});}
finally{
 for(const client of clients)await client.close();
 await writeFile(new URL('live-client-records.json',folder),JSON.stringify({failure,clients:clients.map(c=>({messages:c.messages,sent:c.socket.sent,raw:c.socket.nativeFrames,errors:c.errors})),connections:connections.length}));
}

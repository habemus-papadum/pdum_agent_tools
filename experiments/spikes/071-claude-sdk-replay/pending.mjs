import assert from'node:assert/strict';import{readFile,writeFile}from'node:fs/promises';
import{query}from'@anthropic-ai/claude-agent-sdk/browser';
import{installFeedAdapter,openClient,until}from'./client.mjs';
assert(process.argv.includes('--live'));
const folder=new URL('../../artifacts/071-claude-sdk-replay/',import.meta.url);
const previous=JSON.parse(await readFile(new URL('live.json',folder),'utf8'));
const clients=[];let first,second,after;installFeedAdapter({passiveReplay:true});
try{
 const a=await openClient(query,previous.url,{canUseTool:async(name,input,options)=>new Promise(resolve=>{first={name,input,options,resolve};})});clients.push(a);
 const before=a.messages.filter(m=>m.type==='result').length;
 a.send('Use Bash once to run `printf SDK_PENDING_071` and then reply SDK_PENDING_071.');
 await until(()=>first,40000);
 a.socket.socket.close(4001,'Lost connection during permission');await a.completion;
 const b=await openClient(query,previous.url,{canUseTool:async(name,input,options)=>new Promise(resolve=>{second={name,input,options,resolve};})});clients.push(b);
 await until(()=>second);assert.equal(first.options.requestId,second.options.requestId);
 second.resolve({behavior:'allow',updatedInput:second.input});
 await until(()=>b.messages.filter(m=>m.type==='result').length>before,40000);
 const result=b.messages.filter(m=>m.type==='result').at(-1);assert(!result.is_error);
 await b.session.reinitialize();
 after=b.socket.nativeFrames.filter(x=>x.frame.type==='control_response'&&Array.isArray(x.frame.response.pending_permission_requests)).at(-1).frame.response;
 assert.equal(after.pending_permission_requests.length,0);
 const report={passed:true,requestId:first.options.requestId,sameRequestId:second.options.requestId===first.options.requestId,
   oldCallbackAborted:first.options.signal.aborted,replayRequests:b.socket.nativeFrames.filter(x=>x.replay&&x.frame.type==='control_request').length,
   pendingAfter:after.pending_permission_requests.length,result,totalCostUsd:result.total_cost_usd};
 await writeFile(new URL('pending.json',folder),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}finally{for(const c of clients)await c.close();await writeFile(new URL('pending-client-records.json',folder),JSON.stringify(clients.map(c=>({messages:c.messages,raw:c.socket.nativeFrames,sent:c.socket.sent,errors:c.errors}))));}

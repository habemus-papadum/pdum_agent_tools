import {query}from'@anthropic-ai/claude-agent-sdk/browser';
import {installFeedAdapter,openClient,until}from'./client.mjs';
installFeedAdapter({passiveReplay:true});let current;let callbacks=0;
globalThis.sdk071={
 async open(url){current=await openClient(query,url,{canUseTool:async()=>{callbacks++;return {behavior:'deny',message:'Unexpected permission in browser replay'};}});await until(()=>current.messages.some(m=>m.type==='result'));return this.summary();},
 summary(){return{callbacks,messages:current.messages.length,types:[...new Set(current.messages.map(m=>m.type))],results:current.messages.filter(m=>m.type==='result').map(r=>({uuid:r.uuid,result:r.result,cost:r.total_cost_usd})),raw:current.socket.nativeFrames.length,replayEnded:current.socket.events.some(e=>e.kind==='replay-end'),errors:current.errors};},
 async send(){const before=current.messages.filter(m=>m.type==='result').length;current.send('Without tools, repeat the exact marker printed by the earlier Bash command.');await until(()=>current.messages.filter(m=>m.type==='result').length>before,30000);return this.summary();},
 async drop(){current.socket.socket.close(4001,'Browser disconnect qualification');await current.completion;return this.summary();},
 async control(){await current.session.interrupt();return this.summary();},
 async close(){await current.close();return this.summary();},
};

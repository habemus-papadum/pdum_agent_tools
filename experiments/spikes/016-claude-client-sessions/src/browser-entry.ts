import { query, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk/browser";
import type { WorkerStatus } from "./server.js";

type Json=Record<string,unknown>;
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private values:SDKUserMessage[]=[];
  private waiting:((value:IteratorResult<SDKUserMessage>)=>void)|undefined;
  private closed=false;
  push(text:string){
    const value:SDKUserMessage={type:"user",message:{role:"user",content:text},parent_tool_use_id:null,session_id:"",uuid:crypto.randomUUID()};
    if(this.waiting){const done=this.waiting;this.waiting=undefined;done({done:false,value});}else this.values.push(value);
  }
  close(){this.closed=true;this.waiting?.({done:true,value:undefined});}
  [Symbol.asyncIterator]():AsyncIterator<SDKUserMessage>{return {next:async()=>{
    const value=this.values.shift();if(value)return {done:false,value};
    if(this.closed)return {done:true,value:undefined};
    return new Promise(done=>{this.waiting=done;});
  }};}
}
async function api<T>(path:string,method="GET",body?:unknown):Promise<T>{
  const response=await fetch(path,{method,...(body===undefined?{}:{headers:{"content-type":"application/json"},body:JSON.stringify(body)})});
  const result=await response.json();if(!response.ok)throw new Error(`${method} ${path}: ${JSON.stringify(result)}`);return result as T;
}
const pause=(ms:number)=>new Promise(done=>setTimeout(done,ms));
async function waitFor(test:()=>boolean|Promise<boolean>,label:string,timeout=90_000){
  const start=Date.now();while(!await test()){if(Date.now()-start>timeout)throw new Error(`Timed out: ${label}`);await pause(25);}
}
function check(condition:unknown,label:string):asserts condition {if(!condition)throw new Error(label);report.checks.push(label);render();}
const report:{status:string;checks:string[];sessions:Json[];steps:Json[];errors:string[];userAgent:string;startedAt:string;endedAt?:string}={
  status:"ready",checks:[],sessions:[],steps:[],errors:[],userAgent:navigator.userAgent,startedAt:new Date().toISOString(),
};
function render(){document.querySelector("#output")!.textContent=JSON.stringify(report,null,2);}
type Session={worker:WorkerStatus;input:InputQueue;session:ReturnType<typeof query>;frames:SDKMessage[];completion:Promise<void>;state:{error:string|null};close():Promise<void>};
const opened:Session[]=[];
async function connect(profileId:string,resume?:string,hook?:()=>Promise<void>):Promise<Session>{
  const worker=await api<WorkerStatus>("/api/workers","POST",{profileId,...(resume?{resume}:{})});
  const input=new InputQueue();const frames:SDKMessage[]=[];const callbacks:Json[]=[];
  const session=query({websocket:{url:worker.websocketUrl},prompt:input,hooks:{UserPromptSubmit:[{hooks:[async()=>{
    callbacks.push({kind:"UserPromptSubmit",at:Date.now()});if(hook)await hook();return {};
  }]}]}});
  const state={worker,frames,callbacks,error:null as string|null,initialization:null as unknown};
  report.sessions.push(state);
  const completion=(async()=>{try{for await(const frame of session)frames.push(frame);}catch(error){state.error=String(error);}})();
  const result={worker,input,session,frames,completion,state,async close(){
    session.close();input.close();await completion;
    await waitFor(async()=> (await api<WorkerStatus>(`/api/workers/${worker.id}`)).status==="stopped","worker stopped",15_000);
  }};opened.push(result);
  state.initialization=await session.initializationResult();return result;
}
async function turn(session:Session,text:string):Promise<SDKResultMessage>{
  const count=session.frames.filter(f=>f.type==="result").length;
  report.steps.push({operation:"input",workerId:session.worker.id,text,at:Date.now()});render();session.input.push(text);
  await waitFor(()=>session.frames.filter(f=>f.type==="result").length>count||!!session.state.error,"Haiku result");
  if(session.state.error)throw new Error(session.state.error);
  const result=session.frames.filter((f):f is SDKResultMessage=>f.type==="result").at(-1)!;
  check(!result.is_error&&result.subtype==="success",`Successful result for ${session.worker.id}`);return result;
}
function textOf(result:SDKResultMessage){return "result" in result?result.result:"";}
async function run(){
  if(report.status!=="ready")throw new Error("One bounded run per server/page");report.status="running";render();
  try{
    const config=await api<{live:boolean}>("/config");
    check(config.live,"Explicit live mode enabled");
    const profiles=await api<Array<{id:string}>>("/api/profiles");check(profiles.length===2,"Two profiles listed through management API");
    check((await api<unknown[]>("/api/profiles/a/sessions")).length===0,"Profile history initially empty");
    // Both native hooks rendezvous before either prompt can reach inference.
    let arrivals=0;let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});
    const hook=async()=>{if(++arrivals===2)release();await gate;};
    const [a,b]=await Promise.all([connect("a",undefined,hook),connect("a",undefined,hook)]);
    check(a.worker.pid!==b.worker.pid&&a.worker.conversationId!==b.worker.conversationId,"Two same-profile clients own distinct workers/conversations");
    const marker="CEDAR_016_MEMORY";
    const [ra,rb]=await Promise.all([turn(a,`Remember this marker for later: ${marker}. Reply exactly SAVED.`),turn(b,"Reply exactly SECOND.")]);
    check(textOf(ra).includes("SAVED")&&textOf(rb).includes("SECOND"),"Independent live replies returned through official browser SDK");
    check([a,b].every(s=>s.frames.some(f=>f.type==="stream_event")),"Both conversations streamed partial events");
    await a.close();await b.session.interrupt();
    check((await api<WorkerStatus>(`/api/workers/${b.worker.id}`)).status==="connected","Disconnecting one client leaves the other usable");
    await b.close();
    await api(`/api/profiles/a/sessions/${a.worker.conversationId}`,"PATCH",{title:"Browser source"});
    const history=await api<Array<{sessionId:string;customTitle?:string}>>("/api/profiles/a/sessions");
    check(history.some(s=>s.sessionId===a.worker.conversationId&&s.customTitle==="Browser source"),"List and rename use management API after worker exit");
    check((await api<unknown[]>("/api/profiles/b/sessions")).length===0,"Other profile cannot list these conversations despite shared workspace");
    const source=await api<{info:Json;messages:Array<{uuid:string;type:string}>}>(`/api/profiles/a/sessions/${a.worker.conversationId}`);
    const branchPoint=source.messages.findLast(m=>m.type==="assistant");check(branchPoint,"Official history helper returns a branchable message");
    const fork=await api<{sessionId:string}>(`/api/profiles/a/sessions/${a.worker.conversationId}/fork`,"POST",{title:"Browser fork",upToMessageId:branchPoint.uuid});
    check(fork.sessionId!==a.worker.conversationId,"Fork creates a separate conversation ID");
    const afterFork=await api<{messages:unknown[]}>(`/api/profiles/a/sessions/${a.worker.conversationId}`);
    check(JSON.stringify(source.messages)===JSON.stringify(afterFork.messages),"Fork preserves source messages");
    const forked=await connect("a",fork.sessionId);
    const rf=await turn(forked,"What exact marker did I ask you to remember? Reply with the marker only.");
    check(textOf(rf).includes(marker),"Fork resumes inherited context in a new browser-owned SDK session");await forked.close();
    const resumed=await connect("a",a.worker.conversationId);
    check(resumed.worker.id!==a.worker.id&&resumed.worker.conversationId===a.worker.conversationId,"Explicit resume creates a new worker with original conversation ID");
    const rr=await turn(resumed,"What exact marker did I ask you to remember? Reply with the marker only.");
    check(textOf(rr).includes(marker),"Cold resume preserves original context");await resumed.close();
    check((await api<WorkerStatus[]>("/api/workers")).every(w=>w.status==="stopped"),"All client sessions end with stopped workers");
    report.status="passed";
  }catch(error){report.status="failed";report.errors.push(String(error));}
  finally{
    for(const session of opened)try{await session.close();}catch(error){report.errors.push(String(error));report.status="failed";}
    report.endedAt=new Date().toISOString();render();await api("/report","POST",report);
  }
  return {status:report.status,checks:report.checks,errors:report.errors};
}
const global=globalThis as unknown as {spike016:{run:typeof run;report:typeof report;open:typeof connect}};
global.spike016={run,report,open:connect};
document.querySelector("#run")!.addEventListener("click",()=>{void run();});render();

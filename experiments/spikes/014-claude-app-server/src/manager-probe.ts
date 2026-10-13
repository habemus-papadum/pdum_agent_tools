import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PassThrough } from "node:stream";
import { attachStdio, serveSession } from "./adapters.js";
import { createIsolatedProfile, launchWorker, writeJson, type ClaudeWorker } from "./launch.js";
import { SessionCore, type Event, type Frame, type WorkerPort } from "./manager.js";

export function workerPort(worker: ClaudeWorker): WorkerPort {
  return {
    send: frame => worker.send(frame), stop: () => worker.stop(),
    onFrame(callback) { worker.on("frame", callback); return () => { worker.off("frame", callback); }; },
    onExit(callback) {
      const handler = (code: number | null, signal: string | null) => callback(`code=${code},signal=${signal}`);
      worker.on("exit", handler); return () => { worker.off("exit", handler); };
    },
  };
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now()+20_000;
  while (!predicate()) { if (Date.now()>deadline) throw new Error("native manager probe deadline exceeded"); await delay(10); }
}

/** Two genuine credential-free Claude processes; no fabricated model responses. */
export async function runManagerProbe(output: string) {
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(tmpdir(), "spike014-manager-"));
  const wa = launchWorker(createIsolatedProfile(join(root,"a")),join(output,"worker-a"));
  const wb = launchWorker(createIsolatedProfile(join(root,"b")),join(output,"worker-b"));
  const a = new SessionCore("profile-a","conversation-a",workerPort(wa));
  const b = new SessionCore("profile-b","conversation-b",workerPort(wb));
  const server = await serveSession(a,"127.0.0.1");
  const input = new PassThrough(); const stdioOutput = new PassThrough(); const stdioEvents: Event[]=[];
  let stdioPending="";
  stdioOutput.on("data",chunk=>{
    stdioPending+=chunk.toString();const lines=stdioPending.split("\n");stdioPending=lines.pop()??"";
    for(const line of lines) if(line) stdioEvents.push(JSON.parse(line) as Event);
  });
  const detach=attachStdio(b,input,stdioOutput,"stdio-sdk");
  const ws = new WebSocket(`${server.url}?role=controller&owner=node`);
  const wsEvents: Event[]=[];
  ws.onmessage=event=>wsEvents.push(JSON.parse(String(event.data)) as Event);
  const observed: Event[]=[];
  a.attach({role:"observer",cursor:0,deliver:event=>{observed.push(event);}});
  try {
    await new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=()=>reject(new Error("WS failed"));});
    const initialize = {type:"control_request",request_id:"same-client-request-id",request:{subtype:"initialize",hooks:{},sdkMcpServers:[]}};
    ws.send(JSON.stringify(initialize));input.write(`${JSON.stringify(initialize)}\n`);
    await until(()=>wsEvents.some(e=>e.frame?.type==="control_response")&&stdioEvents.some(e=>e.frame?.type==="control_response"));
    const ar = wsEvents.find(e=>e.frame?.type==="control_response")!.frame.response as Frame;
    const br = stdioEvents.find(e=>e.frame?.type==="control_response")!.frame.response as Frame;
    assert.equal(ar.subtype,"success");assert.equal(br.subtype,"success");
    assert.equal(ar.request_id,"same-client-request-id");assert.equal(br.request_id,"same-client-request-id");
    assert.notEqual(a.workerId,b.workerId);assert.notEqual(wa.child.pid,wb.child.pid);
    assert.notEqual(wa.sent[0]!.request_id,wb.sent[0]!.request_id);
    const cursor=observed.at(-1)!.sequence;
    ws.close();await until(()=>![...a.peers.values()].some(p=>p.role==="controller"));
    assert(wa.alive,"socket close must not terminate worker");
    const replayed: Event[]=[];
    const c=a.attach({role:"controller",owner:"node",cursor,deliver:event=>{replayed.push(event);}});
    c.send({type:"control_request",request_id:"interrupt",request:{subtype:"interrupt"}});
    await until(()=>replayed.some(e=>(e.frame?.response as Frame|undefined)?.request_id==="interrupt"));
    assert.deepEqual(replayed.map(e=>e.sequence),observed.filter(e=>e.sequence>cursor).map(e=>e.sequence));
    await a.stop();assert(wb.alive,"stop of profile A leaves B alive");
    input.write(`${JSON.stringify({type:"control_request",request_id:"after-a-stop",request:{subtype:"interrupt"}})}\n`);
    await until(()=>stdioEvents.some(e=>(e.frame?.response as Frame|undefined)?.request_id==="after-a-stop"));
    writeJson(join(output,"events-a.json"),a.history);writeJson(join(output,"events-b.json"),b.history);
    const result={status:"pass",evidence:"real unmodified Claude workers; no model input",tests:["two-profile independent processes","same request IDs namespaced across workers","WebSocket envelope and stdio envelope controls","disconnect preserves worker","cursor replay order","interrupt controls","stop independence"],pids:[wa.child.pid,wb.child.pid],workerIds:[a.workerId,b.workerId],root,modelRequests:0,costEstimateUsd:0,restartReplay:"unsupported; in-memory history is lost",controllerMode:"one logical controller, multiple observers; fresh SDK reconnect unsupported"};
    writeJson(join(output,"result.json"),result);return result;
  } finally {ws.close();detach();await server.close();await a.stop();await b.stop();}
}

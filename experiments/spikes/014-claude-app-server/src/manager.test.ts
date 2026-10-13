import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createInterface } from "node:readline";
import { attachStdio, serveSession } from "./adapters.js";
import { SessionCore, type Event, type Frame, type WorkerPort } from "./manager.js";

// Real subprocess IPC, deliberately synthetic protocol peer for failure injection.
function fixtureWorker(): WorkerPort & { kill(): void; pid: number } {
  const script = `const r=require('node:readline').createInterface({input:process.stdin});
  const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
  r.on('line', l=>{const x=JSON.parse(l);
    if(x.type==='control_request') send({type:'control_response',response:{subtype:'success',request_id:x.request_id,response:{}}});
    else if(x.type==='user') {send({type:'control_request',request_id:'approval',request:{subtype:'can_use_tool',tool_name:'fixture'}});}
    else if(x.type==='control_response') {send({type:'stream_event',event:{delta:'a'}});setTimeout(()=>send({type:'result',subtype:'success'}),10);}
    else send(x);
  });`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  const events = new EventEmitter();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => events.emit("frame", JSON.parse(line)));
  child.once("exit", (code, signal) => events.emit("exit", `code=${code},signal=${signal}`));
  return {
    pid: child.pid!, kill() { child.kill("SIGKILL"); },
    send(frame) { child.stdin.write(`${JSON.stringify(frame)}\n`); },
    onFrame(callback) { events.on("frame", callback); return () => events.off("frame", callback); },
    onExit(callback) { events.on("exit", callback); return () => events.off("exit", callback); },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = once(child, "exit"); child.kill(); await ended; lines.close();
    },
  };
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("test deadline exceeded"); await delay(5); }
}
function initialize(id = "collision"): Frame { return { type: "control_request", request_id: id, request: { subtype: "initialize" } }; }
const approval: Frame = { type: "control_response", response: { request_id: "approval", subtype: "success", response: { behavior: "allow", updatedInput: {} } } };

test("one controller, callback reconnect, receipt deduplication, observer replay, unknown frame fidelity", async () => {
  const worker = fixtureWorker(); const core = new SessionCore("a", "conversation-a", worker);
  try {
    const events: Event[] = []; const observed: Event[] = [];
    const c = core.attach({ role: "controller", owner: "sdk", deliver: e => { events.push(e); } });
    const observer = core.attach({ role: "observer", deliver: e => { observed.push(e); } });
    assert.throws(() => core.attach({ role: "controller", deliver() {} }), /already attached/);
    assert.throws(() => observer.send({type:"control_request",request:{subtype:"interrupt"}}), /observer/);
    c.send(initialize());
    assert.throws(() => c.send(initialize()), /already initialized/);
    await until(() => events.length === 1);
    assert.equal((events[0]!.frame.response as Frame).request_id, "collision");
    const user = { type: "user", uuid: "input-1", message: { content: "fixture" } };
    assert.equal(c.send(user)?.state, "written");
    assert.equal(c.send(user)?.state, "duplicate");
    assert.throws(() => c.send({ ...user, uuid: "input-2" }), /turn active/);
    assert.throws(() => c.send({ ...user, message: {content:"different"} }), /different content/);
    await until(() => core.pendingCallbacks.size === 1);
    const cursor = observed.at(-1)!.sequence;
    c.detach();
    assert.throws(() => core.attach({ role: "controller", owner: "different-sdk", deliver() {} }), /handoff/);
    const reconnectEvents: Event[] = [];
    const reconnect = core.attach({ role: "controller", owner: "sdk", cursor, deliver: e => { reconnectEvents.push(e); } });
    assert.equal(reconnect.pending.length, 1);
    reconnect.send(approval);
    assert.throws(() => reconnect.send(approval), /duplicate or stale/);
    await until(() => observed.some(e => e.frame?.type === "result"));
    assert.deepEqual(reconnectEvents.map(e=>e.sequence), observed.filter(e=>e.sequence>cursor).map(e=>e.sequence));
    const future = {type:"future_sdk_extension",nested:{unrecognized:[1,"x"]}};
    reconnect.send(future);
    await until(() => observed.some(e=>e.frame?.type === "future_sdk_extension"));
    assert.deepEqual(observed.at(-1)!.frame, future);
    assert.equal(reconnect.send({ ...user, uuid: "input-3" })?.state, "written", "result ends turn, not worker");
  } finally { await core.stop(); }
});

test("slow observer does not delay controller; a cursor recovers every event", async () => {
  const worker = fixtureWorker(); const core = new SessionCore("a", "b", worker);
  try {
    let unblock!: () => void; const blocked = new Promise<void>(resolve => { unblock = resolve; });
    let disconnected = ""; const fast: Event[] = [];
    core.attach({ role: "observer", maxPending: 2, deliver: () => blocked, disconnected: reason => { disconnected = reason; } });
    const c = core.attach({ role: "controller", deliver: e => { fast.push(e); } });
    for (let i=0;i<20;i++) c.send({type:"future",i});
    await until(()=>fast.length === 20);
    assert.match(disconnected,/slow observer/);
    const replay: Event[] = [];
    core.attach({role:"observer",cursor:0,deliver:e=>{replay.push(e);}});
    await until(()=>replay.length===20);
    assert.deepEqual(replay.map(e=>e.sequence),Array.from({length:20},(_,i)=>i+1));
    unblock();
  } finally { await core.stop(); }
});

test("real WebSocket and stream adapters share core; two workers and stop are independent", async () => {
  const a = new SessionCore("profile-a", "conversation-a", fixtureWorker());
  const b = new SessionCore("profile-b", "conversation-b", fixtureWorker());
  const server = await serveSession(a, "127.0.0.1");
  const input = new PassThrough(); const output = new PassThrough(); let text = "";
  output.on("data", chunk => { text += chunk.toString(); });
  const detach = attachStdio(b, input, output, "stdio");
  const ws = new WebSocket(`${server.url}?role=controller&owner=node`);
  try {
    await new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=()=>reject(new Error("WS failed"));});
    const seen: Event[] = []; ws.onmessage=e=>seen.push(JSON.parse(String(e.data)) as Event);
    ws.send(JSON.stringify(initialize())); input.write(`${JSON.stringify(initialize())}\n`);
    await until(()=>seen.some(e=>e.frame?.type === "control_response") && text.includes("control_response"));
    assert.notEqual(a.workerId,b.workerId);
    ws.close(); await delay(20);
    await a.stop();
    input.write(`${JSON.stringify({type:"future",value:"still alive"})}\n`);
    await until(()=>text.includes("still alive"));
    assert.ok(!text.includes(a.workerId));
    input.end(); await delay(10);
    assert.equal(b.peers.size,0);
  } finally { ws.close(); detach(); await server.close(); await a.stop(); await b.stop(); }
});

test("worker crash invalidates callbacks and reports ambiguous inputs; manager has no automatic retry", async () => {
  const worker = fixtureWorker(); const core = new SessionCore("a", "b", worker); const events: Event[] = [];
  try {
    const c = core.attach({role:"controller",deliver:e=>{events.push(e);}});
    c.send({type:"user",uuid:"uncertain",message:{content:"fixture"}});
    await until(()=>core.pendingCallbacks.size===1);
    worker.kill(); await until(()=>events.some(e=>e.kind === "exit"));
    assert.equal(core.pendingCallbacks.size,0);
    assert.deepEqual(events.at(-1)!.frame.lostCallbacks,["approval"]);
    assert.equal(core.inputReceipts.get("uncertain")!.receipt.execution,"unknown");
    assert.throws(()=>c.send(approval),/closed/);
    const replacement = new SessionCore("a","b",fixtureWorker());
    assert.equal(replacement.history.length,0,"manager restart has no durable replay in this spike");
    assert.notEqual(replacement.workerId,core.workerId);
    await replacement.stop();
  } finally { await core.stop(); }
});

test("failed initialize write can retry; server-assigned input ID supports an identical retry", async () => {
  let first = true;
  const actual = fixtureWorker();
  const port: WorkerPort = { ...actual, send(frame) {
    if (first) { first = false; throw new Error("injected write failure"); }
    actual.send(frame);
  } };
  const core = new SessionCore("p", "c", port);
  try {
    const events: Event[] = [];
    const c = core.attach({ role: "controller", deliver: e => { events.push(e); } });
    assert.throws(() => c.send(initialize()), /injected/);
    c.send(initialize());
    await until(() => events.some(e => e.frame?.type === "control_response"));
    const frame = { type: "user", message: {content:"with assigned ID"} };
    const receipt = c.send(frame)!;
    assert.equal(c.send({ ...frame, uuid: receipt.inputId })?.state, "duplicate");
  } finally { await core.stop(); }
});

test("WebSocket reconnect snapshot restores a callback whose original event is before the cursor", async () => {
  const core = new SessionCore("p", "c", fixtureWorker());
  const c = core.attach({role:"controller",owner:"web",deliver() {}});
  const server = await serveSession(core,"127.0.0.1");
  let socket: WebSocket | undefined;
  try {
    c.send({type:"user",uuid:"pending",message:{content:"fixture"}});
    await until(()=>core.pendingCallbacks.size===1);
    const cursor=core.history.length;
    c.detach();
    socket=new WebSocket(`${server.url}?role=controller&owner=web&cursor=${cursor}`);
    const messages: Array<Record<string,unknown>>=[];
    socket.onmessage=event=>messages.push(JSON.parse(String(event.data)));
    await until(()=>messages.some(message=>!!message.snapshot));
    const snapshot=messages.find(message=>!!message.snapshot)!.snapshot as {pendingCallbacks:Frame[]};
    assert.equal(snapshot.pendingCallbacks.length,1);
    assert.equal(snapshot.pendingCallbacks[0]!.request_id,"approval");
    socket.send(JSON.stringify(approval));
    await until(()=>core.pendingCallbacks.size===0);
  } finally {socket?.close();await server.close();await core.stop();}
});

test("paused network observer overflows independently while complete history and controller progress remain", async () => {
  const { WebSocket: TestWebSocket } = await import("ws");
  const core = new SessionCore("p", "c", fixtureWorker());
  const server = await serveSession(core, "127.0.0.1");
  const socket = new TestWebSocket(server.url);
  try {
    await once(socket, "open");
    socket.pause();
    const fast: Event[] = [];
    const c = core.attach({ role: "controller", deliver: event => { fast.push(event); } });
    const payload = "x".repeat(64 * 1024);
    for (let i = 0; i < 350; i++) c.send({ type: "fixture-network-pressure", i, payload });
    await until(() => fast.length === 350);
    await until(() => ![...core.peers.values()].some(peer => peer.role === "observer"));
    assert.equal(core.history.length, 350, "delivery overflow does not discard canonical history");
    assert.equal(core.history.at(-1)!.frame.i, 349);
  } finally { socket.terminate(); await server.close(); await core.stop(); }
});

test("explicit stop delivers the terminal exit event before detaching a responsive observer", async () => {
  const core = new SessionCore("p", "c", fixtureWorker());
  const events: Event[] = [];
  let closed = false;
  core.attach({ role: "observer", deliver: event => { events.push(event); }, disconnected: () => { closed = true; } });
  await core.stop();
  await until(() => closed);
  assert.equal(events.at(-1)?.kind, "exit");
});

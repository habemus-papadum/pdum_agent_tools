import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { launchWorker, workerArgs, writeJson, type ClaudeWorker, type IsolatedProfile } from "../../014-claude-app-server/src/launch.js";
import { ProfileStorage } from "./storage.js";

export interface WorkerStatus {
  id: string; pid: number | undefined; profileId: string; conversationId: string;
  status: "waiting" | "connected" | "stopping" | "stopped";
  websocketUrl: string; reason?: string; exitCode?: number | null; signal?: string | null;
  startedAt: string; stoppedAt?: string;
}
type ManagedWorker = {status:WorkerStatus; worker:ClaudeWorker; socket?:WebSocket; input:Buffer[]; stop?:Promise<void>};
export interface ManagerOptions {
  profiles: Record<string, IsolatedProfile>; outputDirectory: string; host?: string; heartbeatMs?: number;
  serve?: (request:IncomingMessage,response:ServerResponse) => Promise<boolean>;
}

/** Process supervision + host storage API. No SDK query or callback interpreter lives here. */
export async function createManager(options: ManagerOptions) {
  mkdirSync(options.outputDirectory, {recursive:true,mode:0o700});
  const workers = new Map<string, ManagedWorker>();
  const storage = new Map<string, ProfileStorage>();
  const sockets = new WebSocketServer({noServer:true, maxPayload:0});
  let closing = false;
  let baseUrl = "";
  const profile = (id:string) => {
    const selected = options.profiles[id];
    if (!selected) throw new HttpError(404, "Unknown profile");
    return selected;
  };
  const helper = (id:string) => {
    const selected = profile(id);
    if (!storage.get(id)?.alive) storage.set(id,new ProfileStorage(selected));
    return storage.get(id)!;
  };
  const getWorker = (id:string) => {
    const selected = workers.get(id);
    if (!selected) throw new HttpError(404, "Unknown worker");
    return selected;
  };
  function save() {
    writeJson(join(options.outputDirectory,"workers.json"), [...workers.values()].map(w=>w.status));
  }
  async function stop(record:ManagedWorker, reason:string):Promise<void> {
    if (record.stop) return record.stop;
    record.status.reason ??= reason;
    record.status.status = "stopping";
    record.socket?.terminate();
    record.stop = (async()=>{
      await record.worker.stop();
      record.status.status = "stopped";
      record.status.stoppedAt ??= new Date().toISOString();
      writeFileSync(join(record.worker.outputDirectory,"relay-input.ndjson"),Buffer.concat(record.input),{mode:0o600});
      save();
    })();
    return record.stop;
  }
  const http = createServer((request,response) => {
    void (async()=>{
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (!path.startsWith("/api/")) {
        if (options.serve && await options.serve(request,response)) return;
        throw new HttpError(404,"Not found");
      }
      if (closing) throw new HttpError(503,"Manager stopping");
      const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
      const method = request.method;
      if (parts[1] === "profiles") {
        if (parts.length === 2 && method === "GET") {
          json(response,200,Object.entries(options.profiles).map(([id,p])=>({id,configDirectory:p.configDirectory,workDirectory:p.workDirectory,model:p.model}))); return;
        }
        const profileId = parts[2]!;
        if (parts[3] !== "sessions") throw new HttpError(404,"Not found");
        const store = helper(profileId);
        if (parts.length === 4 && method === "GET") { json(response,200,await store.call("list")); return; }
        const sessionId = parts[4]!;
        const info = await store.call("info",{sessionId});
        if (!info) throw new HttpError(404,"Conversation not found in profile/workspace");
        if (parts.length === 5 && method === "GET") { json(response,200,{info,messages:await store.call("read",{sessionId})}); return; }
        const body = await readBody(request);
        if (parts.length === 5 && method === "PATCH") {
          if (typeof body.title !== "string") throw new HttpError(400,"title required");
          await store.call("rename",{sessionId,title:body.title}); json(response,200,await store.call("info",{sessionId})); return;
        }
        if (parts[5] === "fork" && method === "POST") {
          json(response,201,await store.call("fork",{sessionId,...(typeof body.title === "string"?{title:body.title}:{}),...(typeof body.upToMessageId === "string"?{upToMessageId:body.upToMessageId}:{})}));return;
        }
      }
      if (parts[1] === "workers") {
        if (parts.length === 2 && method === "GET") { json(response,200,[...workers.values()].map(w=>w.status)); return; }
        if (parts.length === 2 && method === "POST") {
          const body = await readBody(request);
          const profileId = String(body.profileId ?? "");
          const selected = profile(profileId);
          const resume = typeof body.resume === "string" ? body.resume : undefined;
          if (resume && !await helper(profileId).call("info",{sessionId:resume})) throw new HttpError(404,"Resume conversation not found");
          if (closing) throw new HttpError(503,"Manager stopping");
          const id = randomUUID();
          const conversationId = resume ?? randomUUID();
          const worker = launchWorker(selected,join(options.outputDirectory,id),{args:workerArgs(selected,{
            maxTurns:3,maxBudgetUsd:0.05,permissionMode:"bypassPermissions",
            ...(resume?{resume}:{sessionId:conversationId}),
          }).filter(arg=>arg!=="--setting-sources="&&arg!=="--disable-slash-commands").concat("--setting-sources=user,project")});
          const endpoint=`ws://${request.headers.host??new URL(baseUrl).host}/workers/${id}`;
          const status:WorkerStatus = {id,pid:worker.child.pid,profileId,conversationId,status:"waiting",websocketUrl:endpoint,startedAt:new Date().toISOString()};
          const record:ManagedWorker = {status,worker,input:[]}; workers.set(id,record);
          worker.on("workerError",()=>{void stop(record,"worker I/O error");});
          worker.on("exit",(code:number|null,signal:string|null)=>{
            status.status="stopped";status.exitCode=code;status.signal=signal;status.stoppedAt=new Date().toISOString();
            status.reason??="worker exit";record.socket?.close(code===0?1000:1011,"Worker exited");save();
          });
          save(); json(response,201,status); return;
        }
        const record=getWorker(parts[2]!);
        if(method==="GET"){json(response,200,record.status);return;}
        if(method==="DELETE"){await stop(record,"explicit stop");json(response,200,record.status);return;}
      }
      throw new HttpError(404,"Not found");
    })().catch(error=>json(response,error instanceof HttpError?error.status:500,{error:error instanceof Error?error.message:String(error)}));
  });
  http.on("upgrade",(request,socket,head)=>{
    const id=new URL(request.url??"/","http://localhost").pathname.match(/^\/workers\/([^/]+)$/)?.[1];
    const record=id?workers.get(id):undefined;
    if(closing||!record||record.status.status!=="waiting") {socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");return;}
    // A worker has one SDK controller. Other conversations may freely share its profile.
    record.status.status="connected";
    sockets.handleUpgrade(request,socket,head,client=>{
      record.socket=client;
      let pong=true;
      const timer=setInterval(()=>{
        if(!pong){void stop(record,"heartbeat timeout");return;}
        pong=false;client.ping();
      },options.heartbeatMs??1000);
      client.on("pong",()=>{pong=true;});
      const forward=(chunk:string|Buffer)=>{if(client.readyState===WebSocket.OPEN)client.send(chunk.toString());};
      // Forward first; the borrowed spike recorder parses its separate copy afterward.
      record.worker.child.stdout.prependListener("data",forward);
      client.on("message",(bytes)=>{
        const buffer=Buffer.from(bytes as Buffer);
        // Forward bytes directly; official SDK owns parsing and control responses.
        record.worker.child.stdin.write(buffer);
        record.input.push(buffer);
      });
      client.on("error",()=>{void stop(record,"client transport error");});
      client.on("close",()=>{
        clearInterval(timer);record.worker.child.stdout.off("data",forward);
        void stop(record,"client disconnected");
      });save();
    });
  });
  await new Promise<void>(done=>http.listen(0,options.host??"0.0.0.0",done));
  const address=http.address();if(!address||typeof address==="string")throw new Error("Missing listen address");
  baseUrl=`http://127.0.0.1:${address.port}`;
  let closePromise:Promise<void>|undefined;
  return {url:baseUrl,async close(){
    closePromise??=(async()=>{
      closing=true;
      await Promise.all([...workers.values()].map(record=>stop(record,"manager shutdown")));
      await Promise.all([...storage.values()].map(store=>store.close()));
      await new Promise<void>(done=>sockets.close(()=>done()));
      // Foreground shutdown must also end incomplete HTTP request bodies.
      http.closeAllConnections();
      await new Promise<void>(done=>http.close(()=>done()));save();
    })();return closePromise;
  }};
}

class HttpError extends Error {constructor(readonly status:number,message:string){super(message);}}
function json(response:ServerResponse,status:number,value:unknown){response.writeHead(status,{"content-type":"application/json"});response.end(JSON.stringify(value));}
async function readBody(request:IncomingMessage):Promise<Record<string,unknown>>{
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
  try{return JSON.parse(Buffer.concat(chunks).toString()||"{}");}catch{throw new HttpError(400,"Invalid JSON");}
}

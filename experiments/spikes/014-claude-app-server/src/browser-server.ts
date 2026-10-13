import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { writeCostLedger } from "./cost.js";
import { liveAuthentication } from "./auth.js";
import { createIsolatedProfile, launchWorker, workerArgs, writeJson } from "./launch.js";
import { createWorkerRelay } from "./launch-probe.js";

const base=resolve(import.meta.dirname,"../../../artifacts/014-claude-app-server/browser");
mkdirSync(base,{recursive:true,mode:0o700});const out=mkdtempSync(join(base,"run-"));
const live=process.argv.includes("--live");
const block=process.argv.includes("--block");
const auth=live?liveAuthentication(process.argv.includes("--keychain")):undefined;
const profile=createIsolatedProfile(join(out,"profile"),auth?{authEnv:auth.environment}:{});
const worker=launchWorker(profile,join(out,"worker"),{args:workerArgs(profile,{maxTurns:6,maxBudgetUsd:0.05,tools:live?["Bash"]:[]})});
const relay=await createWorkerRelay(worker);
const bundle=await build({entryPoints:[resolve(import.meta.dirname,"browser-harness.ts")],bundle:true,platform:"browser",format:"esm",write:false,banner:{js:"globalThis.process ??= {env:{},argv:[],platform:'browser',cwd:()=>'/',on(){}};"}});
function recordCost() {
  if (!live || !worker.sent.some(frame => frame.type === "user")) return;
  const usage = worker.frames.filter(frame => frame.type === "result").map(frame => ({sessionId:frame.session_id,usage:frame.usage,modelUsage:frame.modelUsage,totalCostUsd:frame.total_cost_usd,subtype:frame.subtype}));
  writeJson(join(out,"summary.json"), {name:"live-real-browser",status:usage.length?"observed-results":"incomplete",selectedModel:profile.model,usage});
  writeCostLedger(out,auth?.provenance??"none");
}
const html=`<!doctype html><html><meta charset="utf-8"><title>Claude app-server browser probe</title><body><h1>Claude SDK browser probe</h1><p>${live?"Live Haiku, up to $0.05 SDK budget":"Credential-free initialization and interrupt"}</p><input id="prompt" value="Reply exactly BROWSER_OK"><button id="send" ${live||block?"":"disabled"}>Send Haiku turn</button><button id="interrupt">Interrupt</button><button id="detach">Detach</button><button id="save">Save evidence</button><p id="status"></p><pre id="output">Initializing…</pre><script type="module" src="/bundle.js"></script></body></html>`;
const server=createServer(async(request,response)=>{
  if(request.url==="/bundle.js"){response.setHeader("content-type","text/javascript");response.end(bundle.outputFiles[0]!.contents);return;}
  if(request.method==="POST"&&request.url==="/report"){
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    writeJson(join(out,"browser-report.json"),JSON.parse(Buffer.concat(chunks).toString()));worker.persist();recordCost();response.end("saved");return;
  }
  response.setHeader("content-type","text/html");response.end(html);
});
await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
const address=server.address();if(!address||typeof address==="string")throw new Error("missing address");
console.log(JSON.stringify({url:`http://127.0.0.1:${address.port}/?ws=${encodeURIComponent(relay.url)}${block?"&block=1":""}`,artifacts:out,live,model:profile.model,authentication:auth?.provenance??"none"}));
let closing=false;
async function close(){if(closing)return;closing=true;clearTimeout(deadline);await relay.close();await worker.stop();recordCost();server.close();}
const deadline=setTimeout(()=>{void close();},10*60_000);
process.on("SIGINT",()=>{void close();});process.on("SIGTERM",()=>{void close();});

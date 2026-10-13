import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { createIsolatedProfile, resolvePinnedClaude, writeJson } from "../../014-claude-app-server/src/launch.js";
import { liveAuthentication } from "../../014-claude-app-server/src/auth.js";
import { createManager } from "./server.js";
import { writeBrowserCostLedger } from "./cost.js";

const base=resolve(import.meta.dirname,"../../../artifacts/016-claude-client-sessions/browser");
mkdirSync(base,{recursive:true,mode:0o700});const out=mkdtempSync(join(base,"run-"));
const live=process.argv.includes("--live");const auth=live?liveAuthentication(process.argv.includes("--keychain")):undefined;
const a=createIsolatedProfile(join(out,"profile-a"),auth?{authEnv:auth.environment}:{});
const b=createIsolatedProfile(join(out,"profile-b"));b.workDirectory=a.workDirectory;
const bundle=await build({entryPoints:[resolve(import.meta.dirname,"browser-entry.ts")],bundle:true,platform:"browser",format:"esm",write:false,
  banner:{js:"globalThis.process ??= {env:{},argv:[],platform:'browser',cwd:()=>'/',on(){}};"}});
writeJson(join(out,"versions.json"),{...resolvePinnedClaude(),node:process.version,date:new Date().toISOString(),authentication:auth?.provenance??"none"});
const html=`<!doctype html><html><meta charset="utf-8"><title>Claude client sessions spike</title><h1>Official browser SDK + management API</h1><p>${live?"Live Haiku: four short turns, $0.05 SDK budget per worker":"Credential-free mode: manual initialization only"}</p><button id="run" ${live?"":"disabled"}>Run browser flow</button><pre id="output"></pre><script type="module" src="/bundle.js"></script></html>`;
const manager=await createManager({profiles:{a,b},outputDirectory:join(out,"manager"),async serve(request,response){
  if(request.url==="/bundle.js"){response.setHeader("content-type","text/javascript");response.end(bundle.outputFiles[0]!.contents);return true;}
  if(request.url==="/config"){response.setHeader("content-type","application/json");response.end(JSON.stringify({live}));return true;}
  if(request.url==="/report"&&request.method==="POST"){
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    writeJson(join(out,"browser-report.json"),JSON.parse(Buffer.concat(chunks).toString()));
    recordCosts();response.setHeader("content-type","application/json");response.end("{\"saved\":true}");return true;
  }
  if(request.url==="/"){response.setHeader("content-type","text/html");response.end(html);return true;}return false;
}});

function recordCosts(){ return writeBrowserCostLedger(out,auth?.provenance??"none",live); }
console.log(JSON.stringify({url:manager.url,artifacts:out,live,model:a.model,authentication:auth?.provenance??"none"}));
let closing=false;
async function close(){if(closing)return;closing=true;clearTimeout(deadline);await manager.close();recordCosts();}
const deadline=setTimeout(()=>{void close();},15*60_000);
process.on("SIGINT",()=>{void close();});process.on("SIGTERM",()=>{void close();});

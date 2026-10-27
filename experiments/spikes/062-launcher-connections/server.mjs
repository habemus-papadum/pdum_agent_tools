import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const here=dirname(fileURLToPath(import.meta.url));
const repo=resolve(here,'../../..');
export function bridge(input,options={}) {
  return new Promise((resolveResult,reject)=>{
    const child=spawn(resolve(repo,'.venv/bin/python'),[resolve(here,'bridge.py')],{cwd:repo,env:{...process.env,...options.env},stdio:['pipe','pipe','pipe']});
    let output='',error='';
    child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);
    child.on('error',reject);child.on('close',code=>{try{const result=JSON.parse(output);if(code||result.error)reject(new Error(result.error||error||'Profile operation failed'));else resolveResult(result);}catch(e){reject(e);}});
    child.stdin.end(JSON.stringify(input));
  });
}
async function readBody(req){let body='';for await(const chunk of req)body+=chunk;return JSON.parse(body||'{}');}
export async function probeEndpoint(input) {
  const base=new URL(input.url);if(!['http:','https:'].includes(base.protocol))throw new Error('Use an HTTP(S) management URL, not the agent WebSocket.');
  if(base.username||base.password)throw new Error('Use the management base URL without embedded credentials.');
  const paths=input.provider==='claude'?['api/profiles','api/status']:input.provider==='codex'?['status','inspect?probe=false']:null;
  if(!paths)throw new Error('Choose the provider API to inspect');
  base.pathname=base.pathname.replace(/\/?$/,'/');base.search='';base.hash='';
  const checked=await Promise.all(paths.map(async path=>{
    const url=new URL(path,base);
    try{const res=await fetch(url,{signal:AbortSignal.timeout(8000),headers:{accept:'application/json'}});const text=await res.text();let data;try{data=JSON.parse(text);}catch{return {path,status:res.status,error:'The endpoint did not return JSON'};}
      if(!res.ok)return {path,status:res.status,error:`HTTP ${res.status}`,data};
      return {path,status:res.status,data};
    }catch(error){return {path,status:null,error:error.message};}
  }));
  for(const check of checked){
    if(check.error)continue;
    const data=check.data;
    const recognized=check.path==='api/profiles'?Array.isArray(data)&&data.every(p=>p&&typeof p.id==='string'&&typeof p.directory==='string'):
      check.path==='api/status'?data&&Array.isArray(data.workers)&&Array.isArray(data.observation):
      check.path==='inspect?probe=false'?data&&typeof data.home==='string'&&Array.isArray(data.processes):
      data&&typeof data==='object'&&typeof data.run_id==='string';
    if(!recognized)check.error='HTTP responded, but its data does not match this provider management endpoint';
  }
  const ok=checked.every(check=>check.status===200&&!check.error);
  return {url:base.href,provider:input.provider,observedAt:Date.now()/1000,reachable:ok,checks:checked,
    note:'One read-only observation of the selected provider manager. Disconnecting this view does not stop a manager or worker.'};
}
export async function handleRequest(req,res,url) {
  if(!url.pathname.startsWith('/__management-lab/'))return false;
  res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
  try{
    const route=url.pathname.slice('/__management-lab/'.length);
    if(route==='inventory'&&req.method==='GET')res.end(JSON.stringify(await bridge({operation:'inventory'})));
    else if(req.method==='POST'&&['inspect','read','create','save'].includes(route))res.end(JSON.stringify(await bridge({...await readBody(req),operation:route})));
    else if(route==='connect'&&req.method==='POST')res.end(JSON.stringify(await probeEndpoint(await readBody(req))));
    else{res.statusCode=405;res.end(JSON.stringify({error:'Unsupported route or method'}));}
  }catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}
  return true;
}

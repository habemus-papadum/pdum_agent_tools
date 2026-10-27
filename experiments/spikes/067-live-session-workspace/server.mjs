/** Lazy application-owned backend. This module never starts a provider query. */
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,open} from 'node:fs/promises';

const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'../../..');
let owner=null,starting=null;

async function start(){
  if(owner&&owner.child.exitCode===null&&owner.child.signalCode===null)return owner;
  if(starting)return starting;
  starting=(async()=>{
    const directory=resolve(process.env.PDUM_LIVE_LAB_DIR||resolve(repo,'experiments/artifacts/067-live-session-workspace'));
    await mkdir(directory,{recursive:true});
    const log=await open(resolve(directory,'backend.log'),'a',0o600);
    const child=spawn(resolve(repo,'.venv/bin/python'),[resolve(here,'backend.py')],{cwd:repo,env:process.env,stdio:['pipe','pipe',log.fd]});
    await log.close();
    const exited=new Promise(resolveExit=>child.once('exit',(code,signal)=>resolveExit({code,signal})));
    const lines=createInterface({input:child.stdout});
    let timer;
    try{
      const details=await Promise.race([
        new Promise((accept,reject)=>lines.once('line',line=>{try{const value=JSON.parse(line);if(value.type!=='live-lab-ready')throw Error('Unexpected startup record');accept(value);}catch(error){reject(error);}})),
        new Promise((_accept,reject)=>{timer=setTimeout(()=>reject(Error('Live service startup timed out')),30000);}),
        exited.then(()=>{throw Error('Live service exited before readiness; inspect its ignored backend.log');}),
        new Promise((_accept,reject)=>child.once('error',reject)),
      ]);
      owner={child,exited,details};return owner;
    }catch(error){child.stdin.end();child.kill('SIGTERM');await exited;throw error;}
    finally{clearTimeout(timer);lines.close();}
  })();
  try{return await starting;}finally{starting=null;}
}

export async function closeLiveLab(){
  const active=owner??(starting?await starting.catch(()=>null):null);owner=null;
  if(!active)return;
  active.child.stdin.end();
  let timer;
  try{const result=await Promise.race([active.exited,new Promise((_accept,reject)=>{timer=setTimeout(()=>reject(Error('Live backend cleanup timed out')),30000);})]);if(result.code!==0)throw Error('Live backend exited without confirming clean shutdown');}
  finally{clearTimeout(timer);}
}

export async function handleRequest(req,res,url){
  if(!url.pathname.startsWith('/__session-lab/'))return false;
  try{
    const active=await start();
    const path=url.pathname.slice('/__session-lab'.length)+url.search;
    const target=new URL(path,active.details.url);
    const parts=[];for await(const part of req)parts.push(part);
    const bytes=parts.length?Buffer.concat(parts):undefined;
    const response=await fetch(target,{method:req.method,headers:bytes?{'content-type':req.headers['content-type']||'application/json'}:{},body:bytes});
    const text=await response.text();
    res.statusCode=response.status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    // Direct worker sockets listen on all interfaces. Adapt their connect host
    // to the browser's preview host without changing any provider protocol bytes.
    let value;try{value=JSON.parse(text);}catch{value={error:'Live backend returned non-JSON data'};res.statusCode=502;}
    const hostname=new URL(`http://${req.headers.host||'127.0.0.1'}`).hostname;
    const rewrite=row=>{if(row?.websocketUrl){const endpoint=new URL(row.websocketUrl);endpoint.hostname=hostname;row.websocketUrl=endpoint.href;}return row;};
    if(Array.isArray(value))value=value.map(rewrite);else rewrite(value);
    res.end(req.method==='HEAD'?undefined:JSON.stringify(value));
  }catch(error){res.statusCode=503;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:error.message||'Live service unavailable'}));}
  return true;
}

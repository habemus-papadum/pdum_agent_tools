import {Rpc} from './rpc.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const endpoint=process.argv[2],cwd=process.argv[3];if(!endpoint||!cwd)throw Error('endpoint and disposable cwd required');
const dir=resolve('artifacts/030-codex-remote-operations/disconnect-'+Date.now());mkdirSync(dir,{recursive:true});const results=[];
for(const kind of ['command','process']){
const a=await Rpc.socket(endpoint,dir+'/'+kind+'-a.jsonl'),b=await Rpc.socket(endpoint,dir+'/'+kind+'-b.jsonl');await a.initialize();await b.initialize();
const handle='same',command=['/bin/sh','-c','echo $$; sleep 30'];let completion;
if(kind==='command')completion=a.request('command/exec',{command,cwd,processId:handle,streamStdoutStderr:true,timeoutMs:35000}).catch(e=>String(e));
else await a.request('process/spawn',{command,cwd,processHandle:handle,streamStdoutStderr:true,timeoutMs:35000});
const event=await a.wait(e=>e.method===`${kind==='command'?'command/exec':'process'}/outputDelta`);const pid=Number(Buffer.from(event.params.deltaBase64,'base64').toString().trim());
let crossError;try{await b.request(kind==='command'?'command/exec/terminate':'process/kill',kind==='command'?{processId:handle}:{processHandle:handle});}catch(e){crossError=e.message;}
a.close();await delay(500);let alive;try{process.kill(pid,0);alive=true;}catch{alive=false;}
if(alive)process.kill(pid,'SIGTERM');b.close();results.push({kind,pid,crossError,aliveAfterDisconnect:alive});
}
writeFileSync(dir+'/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify({dir,results},null,2));

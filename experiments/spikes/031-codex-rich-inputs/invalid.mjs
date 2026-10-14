import {Rpc} from '../030-codex-remote-operations/rpc.mjs';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const dir=resolve('artifacts/031-codex-rich-inputs/invalid-'+Date.now());mkdirSync(dir,{recursive:true});const base=mkdtempSync(join(tmpdir(),'pdum031-invalid-'));const rpc=Rpc.stdio('/Users/nehal/.local/bin/codex',base,base,join(dir,'wire.jsonl'));const result=[];
try{await rpc.initialize();const t=await rpc.request('thread/start',{cwd:base,model:'gpt-6-luna',approvalPolicy:'never',sandbox:'danger-full-access'});for(const image of [{type:'image',url:'data:image/png;base64,AAAA'},{type:'image',url:'http://127.0.0.1/red.png'},{type:'image',url:'data:image/png;base64,'+readFileSync(process.argv[2]).toString('base64'),detail:'low'}]){try{const r=await rpc.request('turn/start',{threadId:t.thread.id,input:[{type:'text',text:'What color?'},image],model:'gpt-6-luna'});result.push({image,r});}catch(e){result.push({image,error:String(e)});}}}finally{rpc.close();writeFileSync(dir+'/results.json',JSON.stringify(result,null,2));console.log(JSON.stringify({dir,result},null,2));}

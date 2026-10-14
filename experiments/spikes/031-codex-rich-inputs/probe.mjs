import {Rpc} from '../030-codex-remote-operations/rpc.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,chmodSync,unlinkSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {deflateSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
process.umask(0o077);
const binary=process.env.SPIKE_CODEX_BIN??'/Users/nehal/.local/bin/codex';
const dir=resolve('artifacts/031-codex-rich-inputs/run-'+Date.now());mkdirSync(dir,{recursive:true});
const base=mkdtempSync(join(tmpdir(),'pdum031-')),home=join(base,'home'),cwd=join(base,'work');mkdirSync(home);mkdirSync(cwd);
copyFileSync(join(process.env.CODEX_HOME??join(homedir(),'.codex'),'auth.json'),join(home,'auth.json'));chmodSync(join(home,'auth.json'),0o600);
function crc(b){let n=0xffffffff;for(const v of b){n^=v;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0)}return (n^0xffffffff)>>>0}
function chunk(type,data){const t=Buffer.from(type),len=Buffer.alloc(4),c=Buffer.alloc(4);len.writeUInt32BE(data.length);c.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([len,t,data,c])}
const header=Buffer.alloc(13);header.writeUInt32BE(16);header.writeUInt32BE(16,4);header[8]=8;header[9]=2;const pixels=Buffer.concat(Array.from({length:16},()=>Buffer.concat([Buffer.from([0]),Buffer.from(Array(16).fill([255,0,0]).flat())])));const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
const imagePath=join(cwd,'red.png');writeFileSync(imagePath,png);writeFileSync(join(dir,'red.png'),png);const dataUrl='data:image/png;base64,'+png.toString('base64');
const server=createServer((q,r)=>{r.setHeader('content-type','image/png');r.end(png)});await new Promise(r=>server.listen(0,'127.0.0.1',r));const imageUrl='http://127.0.0.1:'+server.address().port+'/red.png';
const result={binary,version:spawnSync(binary,['--version'],{encoding:'utf8'}).stdout.trim(),base,cwd,dir,imagePath,cases:[],budgets:{model:'gpt-6-luna',maxAttempts:5,maxTurnSeconds:45,maxWholeSeconds:240,allocationUsd:.10},usage:[],priceDate:'2026-10-14',ratesPerMillion:{input:.10,cachedInput:.01,output:.50}};
let rpc=Rpc.stdio(binary,home,cwd,join(dir,'wire.jsonl'));const timer=setTimeout(()=>rpc.close(),240000);let liveAttempts=0;
async function caseRun(name,input,additionalContext){const t=await rpc.request('thread/start',{cwd,model:'gpt-6-luna',approvalPolicy:'never',sandbox:'danger-full-access',config:{model_reasoning_effort:'low',web_search:'disabled',service_tier:'default'}});const id=t.thread.id;const record={name,threadId:id};result.cases.push(record);liveAttempts++;try{const turn=await rpc.request('turn/start',{threadId:id,input,model:'gpt-6-luna',effort:'low',...(additionalContext?{additionalContext}:{})});record.turnId=turn.turn.id;const end=await rpc.wait(e=>e.method==='turn/completed'&&e.params.threadId===id,45000);record.end=end;record.history=await rpc.request('thread/read',{threadId:id,includeTurns:true});record.events=rpc.events.filter(e=>e.params?.threadId===id);const u=record.events.filter(e=>e.method==='thread/tokenUsage/updated');result.usage.push(...u);console.log(name+' '+end.params.turn.status);}catch(e){record.error=String(e);try{await rpc.request('turn/interrupt',{threadId:id,turnId:record.turnId})}catch{}console.log(name+' ERROR '+e.message)}return record}
try{
await rpc.initialize();const models=await rpc.request('model/list',{includeHidden:true});result.model=models.data.find(m=>m.model==='gpt-6-luna'||m.id==='gpt-6-luna');writeFileSync(join(dir,'models.json'),JSON.stringify(models,null,2));console.log('Luna modalities '+JSON.stringify(result.model?.inputModalities));
if(!result.model?.inputModalities?.includes('image'))throw Error('Luna image modality not advertised; no model substitution');
const text={type:'text',text:'What color is this image? Reply one word. Do not use tools.'};
const data=process.env.SPIKE_LOCAL_ONLY?null:await caseRun('data URL PNG',[text,{type:'image',url:dataUrl}]);
const local=await caseRun('server local PNG',[text,{type:'localImage',path:imagePath}],{probe:{kind:'application',value:'This is a controlled image fixture. Respond in one word.'}});
if(!process.env.SPIKE_LOCAL_ONLY) await caseRun('localhost HTTP URL',[text,{type:'image',url:imageUrl}]);
if(!process.env.SPIKE_LOCAL_ONLY) await caseRun('missing local image',[text,{type:'localImage',path:join(cwd,'missing.png')}]);
// Malformed input is rejected during deserialization and must not start inference.
try{await rpc.request('turn/start',{threadId:(data??local).threadId,input:[{type:'image',url:123}],model:'gpt-6-luna'});result.malformedUnexpected=true}catch(e){result.malformedError=String(e)}
unlinkSync(imagePath);rpc.close();rpc=Rpc.stdio(binary,home,cwd,join(dir,'restart-wire.jsonl'));await rpc.initialize();result.persistence=[];
for(const c of [data,local].filter(Boolean)){const p={name:c.name,threadId:c.threadId};result.persistence.push(p);try{p.read=await rpc.request('thread/read',{threadId:c.threadId,includeTurns:true});p.resume=await rpc.request('thread/resume',{threadId:c.threadId,excludeTurns:false});p.fork=await rpc.request('thread/fork',{threadId:c.threadId});}catch(e){p.error=String(e)}}
}finally{clearTimeout(timer);rpc.close();server.close();try{unlinkSync(join(home,'auth.json'))}catch{}result.liveAttempts=liveAttempts;result.costEstimateUsd=result.usage.reduce((sum,e)=>{const u=e.params.tokenUsage.last;return sum+((u.inputTokens-u.cachedInputTokens)*.1+u.cachedInputTokens*.01+u.outputTokens*.5)/1e6},0);writeFileSync(join(dir,'results.json'),JSON.stringify(result,null,2));console.log('ARTIFACTS '+dir);console.log('USAGE '+JSON.stringify(result.usage.map(e=>e.params)));console.log('ESTIMATE '+result.costEstimateUsd)}

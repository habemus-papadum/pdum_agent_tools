import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import OpenAI from 'openai';

const live = process.argv.includes('--live');
if (live && !process.env.OPENAI_API_KEY) throw Error('OPENAI_API_KEY required');
const root = resolve(process.env.HP070_ARTIFACTS ?? '../../artifacts/070-hp-backend-parity/browser-live');
const publicRoot = resolve('dist');
const responses = new Map(), wire = [], sockets = new Set();
await mkdir(root, {recursive:true});
let requests=0, compactions=0, deadline, stopped=false;
const inputPrices={input:.10,cached:.01,writes:.125,output:.50};
function observe(response,endpoint='responses') {
  if(!response.usage) return;
  const u=response.usage, input=u.input_tokens, output=u.output_tokens;
  const cached=u.input_tokens_details?.cached_tokens??0, writes=u.input_tokens_details?.cache_write_tokens??0;
  responses.set(response.id,{responseId:response.id,endpoint,model:response.model??'gpt-6-luna',input,output,cached,writes,
    estimatedUsd:((input-cached-writes)*.10+cached*.01+writes*.125+output*.50)/1e6});
}
function arm() { deadline??=setTimeout(()=>void stop(),240000); }
async function save() {
  await writeFile(resolve(root,'wire.json'),JSON.stringify(wire));
  await writeFile(resolve(root,'ledger.json'),JSON.stringify({date:new Date().toISOString(),requests,compactions,
    bounds:{responseCreates:10,compactions:1,outputTokens:256,wallSeconds:240,maxEstimatedUsd:.1},
    ratesPerMillion:inputPrices,priceDate:'2026-10-17',responses:[...responses.values()],
    estimatedUsd:[...responses.values()].reduce((n,r)=>n+r.estimatedUsd,0),actualBilledUsd:null},null,2));
}
async function body(req){const parts=[];for await(const part of req)parts.push(part);return JSON.parse(Buffer.concat(parts).toString());}
const server=createServer(async(req,res)=>{
  try {
    const path=new URL(req.url,'http://localhost').pathname;
    res.setHeader('Cache-Control','no-store');
    if(path==='/__spike'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({live,root,pid:process.pid}));return;}
    if(path==='/prices.json'){res.setHeader('Content-Type','application/json');res.end(await readFile('../../../typescript/packages/agent-history/src/litellm-snapshot.json'));return;}
    if(path==='/node-archive.json'){res.setHeader('Content-Type','application/json');res.end(await readFile('../../artifacts/070-hp-backend-parity/node-live/continue-archive.json'));return;}
    if(path==='/report'&&req.method==='POST'){
      const value=await body(req); if(!['seed','continue'].includes(value.phase))throw Error('Unknown report phase');
      await writeFile(resolve(root,`${value.phase}-result.json`),JSON.stringify(value.report));
      await writeFile(resolve(root,`${value.phase}-archive.json`),JSON.stringify(value.report.archive));
      await writeFile(resolve(root,`${value.phase}-export.json`),JSON.stringify(value.exported));
      await save();res.end('{}');return;
    }
    if(path==='/compact'&&req.method==='POST'){
      if(!live||++compactions>1)throw Error('Experiment compaction bound');
      arm();const request=await body(req);if(request.model!=='gpt-6-luna')throw Error('Unexpected model');
      const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY,maxRetries:0,timeout:30000});
      const response=await client.responses.compact(request);observe(response,'responses.compact');await save();
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response));return;
    }
    const file=resolve(publicRoot,`.${path==='/'?'/index.html':path}`);
    if(!file.startsWith(publicRoot+sep))throw Error('Unknown file');
    res.setHeader('Content-Type',extname(file)==='.html'?'text/html':extname(file)==='.js'?'text/javascript':'application/json');
    res.end(await readFile(file));
  }catch(error){res.statusCode=400;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:String(error)}));}
});
const wss=new WebSocketServer({server,path:'/responses'});
wss.on('connection',browser=>{
  if(!live){browser.close(1008,'Live calls disabled');return;}
  arm();sockets.add(browser);
  const upstream=new WebSocket('wss://api.openai.com/v1/responses',{headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},handshakeTimeout:10000});
  sockets.add(upstream);const pending=[];
  upstream.on('open',()=>{for(const data of pending.splice(0))upstream.send(data);});
  browser.on('message',data=>{
    try {
      const event=JSON.parse(data.toString());
      if(event.type!=='response.create'||event.model!=='gpt-6-luna'||++requests>10||event.max_output_tokens>256
        ||[...responses.values()].reduce((n,r)=>n+r.estimatedUsd,0)>.1)throw Error('Experiment response bound');
      wire.push({direction:'client',event});
      if(upstream.readyState===WebSocket.OPEN)upstream.send(data.toString());else pending.push(data.toString());
    }catch{browser.close(1008,'Experiment bound or unexpected message');upstream.close();}
  });
  upstream.on('message',data=>{const event=JSON.parse(data.toString());wire.push({direction:'server',event});
    if(['response.completed','response.failed','response.incomplete'].includes(event.type)){observe(event.response);void save();}
    if(browser.readyState===WebSocket.OPEN)browser.send(data.toString());});
  upstream.on('error',error=>{wire.push({direction:'transport',error:error.message});browser.close(1011,'Upstream failed');});
  browser.on('error',()=>upstream.close());
  browser.on('close',()=>{upstream.close();sockets.delete(browser);void save();});
  upstream.on('close',()=>{sockets.delete(upstream);if(browser.readyState===WebSocket.OPEN)browser.close();});
});
async function stop(){if(stopped)return;stopped=true;clearTimeout(deadline);for(const socket of sockets)socket.terminate();wss.close();server.close();await save();}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
server.listen(Number(process.env.PORT??0),'0.0.0.0',()=>console.log(JSON.stringify({url:`http://localhost:${server.address().port}`,pid:process.pid,root,live})));

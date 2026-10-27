/** Disposable host adapter. No work starts on import. Writes stay in the dedicated lab. */
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const directory=dirname(fileURLToPath(import.meta.url));
const root=resolve(directory,'../../..');
const lab=resolve(process.env.PDUM_INGESTION_LAB_DIR||resolve(root,'experiments/artifacts/061-ingestion-statistics'));
const python=resolve(root,'.venv/bin/python');
const helper=resolve(directory,'bridge.py');
let job=null;
let starting=false;
let saving=false;
let queue=Promise.resolve();
const serialize=operation=>{const next=queue.then(operation);queue=next.catch(()=>{});return next;};
const json=(res,code,value)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
async function body(req){let value='';for await(const c of req)value+=c;return value?JSON.parse(value):{};}
function run(command,args,input){return new Promise((accept,reject)=>{
  const process=spawn(command,args,{cwd:root,stdio:['pipe','pipe','pipe']});let out='',err='';
  process.stdout.on('data',c=>out+=c);process.stderr.on('data',c=>err+=c);process.on('error',reject);
  process.on('close',code=>{try{const data=JSON.parse(out.trim());code===0?accept(data):reject(new Error(data.error||err||`Process exited ${code}`));}catch(error){reject(new Error(err||out||String(error)));}});
  process.stdin.end(input===undefined?'':JSON.stringify(input));
});}
async function config(){return run(python,[helper,'config']);}
async function query(action,options={}){const c=await config();if(!c.available||!c.targets[0]?.exists)return {available:false,reason:'Sync a source to create the local database.'};
  const value=await run(resolve(root,'typescript/node_modules/.bin/tsx'),[resolve(directory,'query.mts')],{path:c.targets[0].path,action,...options});return {available:true,...value};}
async function previousJob(){if(job)return job;try{const value=JSON.parse(await readFile(resolve(lab,'last-run.json'),'utf8'));
  return value.status==='running'?{...value,status:'unknown',error:'The previous host stopped observing this run. Inspect the database before retrying.'}:value;}catch{return null;}}
async function startSync(){
  if(starting||saving||job?.status==='running')throw new Error('A sync or configuration save is already running');
  starting=true;
  try {
  const c=await config();if(!c.available)throw new Error(c.reason);
  const current={id:crypto.randomUUID(),status:'running',startedAt:new Date().toISOString(),events:[],summaries:[],error:null};job=current;
  await mkdir(lab,{recursive:true});await writeFile(resolve(lab,'last-run.json'),JSON.stringify(current));
  // Queue DB readers behind the writer. Source completions are real progress; no invented percentages.
  const finished=serialize(()=>new Promise(done=>{
    const child=spawn(python,[helper,'sync'],{cwd:root,stdio:['ignore','pipe','pipe']});let buffer='',stderr='';
    child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const event=JSON.parse(line);current.events.push({...event,observedAt:new Date().toISOString()});
        if(event.summary)current.summaries.push(event.summary);if(event.error)current.error=event.error;}catch{current.error='Could not decode an ingestor progress record';}
    }});
    child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',error=>{current.error=String(error);});
    child.on('close',async code=>{current.status=code===0?'complete':'failed';current.finishedAt=new Date().toISOString();if(code!==0&&!current.error)current.error=stderr||`Exited ${code}`;
      try{await writeFile(resolve(lab,'last-run.json'),JSON.stringify(current,null,2));}finally{done();}});
  }));
  finished.catch(error=>{current.status='failed';current.error=String(error);});
  return current;
  }finally{starting=false;}
}
/** Returns true for /__ingestion routes, false otherwise. */
export async function handleIngestionRequest(req,res,url){
  if(!url.pathname.startsWith('/__ingestion/'))return false;
  try {
    const route=url.pathname.slice('/__ingestion/'.length);
    if(route==='config'&&req.method==='GET')json(res,200,await config());
    else if(route==='config'&&req.method==='POST'){
      if(starting||saving||job?.status==='running')throw new Error('Wait for the active sync or save before saving its configuration');
      saving=true;
      try{json(res,200,await run(python,[helper,'save'],await body(req)));}finally{saving=false;}
    } else if(route==='sync'&&req.method==='POST')json(res,202,await startSync());
    else if(route==='status'&&req.method==='GET')json(res,200,{job:await previousJob()});
    else if(route==='snapshot'&&req.method==='GET')json(res,200,await serialize(()=>query('snapshot')));
    else if(route==='detail'&&req.method==='GET')json(res,200,await serialize(()=>query('detail',{sourceId:url.searchParams.get('source'),threadId:url.searchParams.get('thread')})));
    else if(route==='question'&&req.method==='GET')json(res,200,await serialize(()=>query('question',{id:url.searchParams.get('id'),term:url.searchParams.get('term')})));
    else json(res,405,{error:'Unsupported ingestion operation'});
  }catch(error){json(res,400,{error:error.message||String(error)});}return true;
}

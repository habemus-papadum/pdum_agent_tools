/** Read already-exported native JSON only. No provider calls or private storage parsing. */
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
const inc=(c,k,n=1)=>c[k]=(c[k]||0)+n;
const textParts=v=>typeof v==='string'?[v]:Array.isArray(v)?v.flatMap(textParts):obj(v).type==='text'?[String(v.text??'')]:[];
const times=['timestamp','createdAt','startedAt','completedAt','durationMs','started_at','completed_at'];
const settings=['model','modelProvider','effort','reasoningEffort','reasoning_effort','serviceTier','service_tier'];
const markers={
  compact: /<command-name>\/?compact<\/command-name>|^\s*\/compact(?:\s|$)/i,
  model: /<command-name>\/?model<\/command-name>|^\s*\/model(?:\s|$)/i,
  'local-command-output': /<local-command-stdout>|<local-command-stderr>/i,
  'task-notification': /<task-notification>|<task_id>|<task-id>/i,
  background: /running in (?:the )?background|background task|background process/i,
  steering: /steer(?:ing|ed)?|queued (?:message|input)|interrupted by (?:the )?user/i,
  'continuation-summary': /continued from a previous conversation|summary of (?:the |our )?(?:conversation|previous)|context (?:was |has been )?compact/i,
  'image-reference': /<image\b|!\[[^\]]*\]\(/i,
};
function images(v,c,origin,path,examples){
  if(Array.isArray(v)){v.forEach((x,i)=>images(x,c,origin,`${path}[${i}]`,examples));return;}
  const b=obj(v);
  if(['image','localImage','inputImage','input_image'].includes(b.type)){
    inc(c,origin);if(examples.filter(x=>x.kind==='image').length<24)examples.push({kind:'image',origin,path});return;
  }
  for(const k of ['content','contentItems','result'])if(b[k])images(b[k],c,b.type==='tool_result'?'tool-output':origin,`${path}.${k}`,examples);
}
export function auditDocument(d){
  const p=obj(d.payload),provider=d.provider,turns=provider==='codex'?(p.thread?.turns??[]):[];
  const rows=provider==='codex'?turns.flatMap((t,ti)=>(t.items??[]).map((raw,i)=>({raw,path:`payload.thread.turns[${ti}].items[${i}]`,role:raw.type==='userMessage'?'user':raw.type==='agentMessage'?'assistant':'tool',text:raw.type==='agentMessage'?[String(raw.text??'')]:raw.type==='userMessage'?textParts(raw.content):[]}))):
    (p.messages??[]).map((w,i)=>({raw:obj(w.message),wrapper:w,path:`payload.messages[${i}]`,role:w.message?.role??w.type,text:textParts(w.message?.content)}));
  const r={provider,corpus:d.source?.corpus??'experiment',items:rows.length,turns:turns.length,nativeTypes:{},phases:{},stopReasons:{},itemTimes:{},turnTimes:{},pagedItemTimes:{entries:0,started:0,completed:0},turnGaps:{over30Minutes:0,maxSeconds:0},itemSettings:{},turnSettings:{},settingsByType:{},models:{},usageRecords:0,toolCalls:{},toolInputKeys:{},backgroundRequests:0,compactions:0,collabOperations:{},childActivities:{},childTargets:[],nativeSteeringFields:0,images:{},markers:{},toolFailures:0,examples:[]};
  const fields=(raw,names,c)=>names.forEach(k=>{if(raw[k]!==null&&raw[k]!==undefined)inc(c,k);});
  for(const t of turns){fields(t,times,r.turnTimes);fields(t,settings,r.turnSettings);}
  for(let i=1;i<turns.length;i++)if(turns[i].startedAt!=null&&turns[i-1].completedAt!=null){
    const gap=turns[i].startedAt-turns[i-1].completedAt; // Turn timestamps are Unix seconds.
    if(gap>1800)r.turnGaps.over30Minutes++;r.turnGaps.maxSeconds=Math.max(r.turnGaps.maxSeconds,gap);
  }
  const pageTimes=v=>{if(!v||typeof v!=='object')return;
    if(v.item&&v.turnId){r.pagedItemTimes.entries++;if(v.startedAtMs!=null)r.pagedItemTimes.started++;if(v.completedAtMs!=null)r.pagedItemTimes.completed++;}
    for(const x of Object.values(v))if(x&&typeof x==='object')pageTimes(x);
  };pageTimes(p.itemPages);
  for(const row of rows){
    const v=row.raw;inc(r.nativeTypes,String(v.type??row.role??'unknown'));
    if(v.phase)inc(r.phases,String(v.phase));if(v.stop_reason)inc(r.stopReasons,String(v.stop_reason));
    fields(v,times,r.itemTimes);if(row.wrapper)fields(row.wrapper,times,r.itemTimes);fields(v,settings,r.itemSettings);
    for(const key of settings)if(v[key]!=null)inc(r.settingsByType,`${v.type??row.role}:${key}`);
    if(v.model)inc(r.models,String(v.model));if(v.usage)r.usageRecords++;if(v.type==='contextCompaction')r.compactions++;
    if(v.type==='collabAgentToolCall'){inc(r.collabOperations,String(v.tool));r.childTargets.push(...(v.receiverThreadIds??[]));if(r.examples.filter(x=>x.kind==='collaboration').length<8)r.examples.push({kind:'collaboration',operation:v.tool,path:row.path});}
    if(v.type==='subAgentActivity'){
      inc(r.childActivities,String(v.kind));if(v.agentThreadId)r.childTargets.push(v.agentThreadId);
      if(r.examples.filter(x=>x.kind==='subagent-activity').length<8)r.examples.push({kind:'subagent-activity',operation:v.kind,path:row.path});
    }
    for(const k of ['isSteering','steering','inputId','expectedTurnId'])if(v[k]!==null&&v[k]!==undefined)r.nativeSteeringFields++;
    if(v.status==='failed'||v.status==='error'||typeof v.exitCode==='number'&&v.exitCode!==0)r.toolFailures++;
    for(const b of provider==='claude'&&Array.isArray(v.content)?v.content:[]){
      if(b.type==='tool_use'){inc(r.toolCalls,String(b.name));const input=obj(b.input);for(const k of Object.keys(input))inc(r.toolInputKeys,`${b.name}.${k}`);if(input.run_in_background===true||input.background===true)r.backgroundRequests++;}
      if(b.type==='tool_result'&&b.is_error===true)r.toolFailures++;
    }
    for(const [name,re]of Object.entries(markers))if(row.text.some(t=>re.test(t))){inc(r.markers,name);if(r.examples.filter(x=>x.kind===name).length<6)r.examples.push({kind:name,path:row.path,role:row.role});}
    if(provider==='codex'){
      if(v.type==='imageGeneration')inc(r.images,'native-image-generation');if(v.type==='imageView')inc(r.images,'image-viewed-by-agent');
      images(v.content,r.images,row.role==='user'?'user-input':`assistant-${v.phase??'phase-unknown'}`,`${row.path}.content`,r.examples);
      images(v.result??v.contentItems,r.images,'tool-output',`${row.path}.result`,r.examples);
      if(row.role==='assistant'&&row.text.some(t=>markers['image-reference'].test(t)))inc(r.images,`text-reference-${v.phase??'phase-unknown'}`);
    }else images(v.content,r.images,row.role==='user'?'user-input':'assistant-phase-unknown',`${row.path}.message.content`,r.examples);
  }
  r.childTargets=[...new Set(r.childTargets)];return r;
}
export async function auditCorpus(directory){
  const catalog=JSON.parse(await readFile(join(directory,'catalog.json'),'utf8')),documents=[];
  for(const [i,entry]of catalog.sessions.entries()){
    const bytes=await readFile(join(directory,'documents',`${entry.key}.json`));
    documents.push({label:`${entry.provider}-${i+1}`,key:entry.key,sessionId:entry.sessionId,version:entry.source.version,sha256:createHash('sha256').update(bytes).digest('hex'),...auditDocument(JSON.parse(bytes))});
  }
  const ids=new Set(documents.map(d=>d.sessionId));for(const d of documents)d.childTargetsPresent=d.childTargets.filter(id=>ids.has(id)).length;
  const totals={documents:documents.length,items:0,providers:{},images:{},markers:{},phases:{},stopReasons:{},collabOperations:{},childActivities:{},itemTimes:{},turnTimes:{}};
  for(const d of documents){totals.items+=d.items;inc(totals.providers,d.provider);for(const k of ['images','markers','phases','stopReasons','collabOperations','childActivities','itemTimes','turnTimes'])for(const [name,n]of Object.entries(d[k]))inc(totals[k],`${d.provider}:${name}`,n);}
  return {auditedAt:new Date().toISOString(),method:'Already-exported native payloads only. Text markers are candidates, not established operations.',totals,documents};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const result=await auditCorpus(resolve(process.argv[2]??'artifacts/058-native-history-access'));
  const output=resolve(process.argv[3]??'artifacts/059-evidence-inventory/audit.json');await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result.totals,null,2));
}

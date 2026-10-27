/** Inspect previously recorded client events. Receipt spans are not tool execution or CPU time. */
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const key=(row,p,item)=>JSON.stringify([row.client,p.threadId,p.turnId,item?.id]);
export function auditRecordedTiming(rows){
  const calls=new Map(),turns=new Map();
  for(const row of rows){const m=row.message??{},p=m.params??{};
    if(m.method==='turn/completed')turns.set(JSON.stringify([row.client,p.threadId,p.turn?.id??p.turnId]),row);
    if(!['item/started','item/completed'].includes(m.method)||!['commandExecution','mcpToolCall','dynamicToolCall'].includes(p.item?.type))continue;
    const id=key(row,p,p.item),call=calls.get(id)??{client:row.client,threadId:p.threadId,turnId:p.turnId,itemId:p.item.id,type:p.item.type};
    if(m.method==='item/started')call.started??=row;
    else call.completed=row;
    calls.set(id,call);
  }
  const items=[...calls.values()].map(c=>{
    const end=c.completed?.message.params.item,turn=turns.get(JSON.stringify([c.client,c.threadId,c.turnId]));
    const hasClocks=Number.isFinite(c.started?.monotonic)&&Number.isFinite(c.completed?.monotonic);
    const receiptSpanMs=hasClocks?(c.completed.monotonic-c.started.monotonic)*1000:null;
    return {client:c.client,threadId:c.threadId,turnId:c.turnId,itemId:c.itemId,type:c.type,
      status:end?.status??'completion-not-observed',reportedDurationMs:end?.durationMs??null,
      receiptSpanMs,clockOrderValid:receiptSpanMs===null?null:receiptSpanMs>=0,
      completionAfterTurnMs:c.completed&&turn?(c.completed.monotonic-turn.monotonic)*1000:null,
      observedStart:Boolean(c.started),observedEnd:Boolean(c.completed)};
  });
  return {items,summary:{items:items.length,withBothEvents:items.filter(x=>x.observedStart&&x.observedEnd).length,
    withoutCompletion:items.filter(x=>!x.observedEnd).length,
    completedAfterParentTurn:items.filter(x=>x.completionAfterTurnMs>0).length,
    invalidReceiptClockOrder:items.filter(x=>x.clockOrderValid===false).length,
    reportedDurationValuesMs:items.map(x=>x.reportedDurationMs).filter(x=>x!==null),
    receiptSpanValuesMs:items.map(x=>x.receiptSpanMs===null?null:Math.round(x.receiptSpanMs*1000)/1000).filter(x=>x!==null)}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length<4)throw new Error('Usage: audit-recorded-timing.mjs OUTPUT.json CLIENTS.jsonl...');
  const sources=[];
  for(const filename of process.argv.slice(3)){
    const bytes=await readFile(resolve(filename));const audit=auditRecordedTiming(bytes.toString().trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
    sources.push({filename,sha256:createHash('sha256').update(bytes).digest('hex'),...audit});
  }
  const output=resolve(process.argv[2]);await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify({auditedAt:new Date().toISOString(),basis:'Existing event captures. Receipt spans use per-client monotonic clocks. No absent completion is synthesized.',sources},null,2));
  console.log(JSON.stringify(sources.map(x=>({source:x.filename.split('/')[1],...x.summary})),null,2));
}

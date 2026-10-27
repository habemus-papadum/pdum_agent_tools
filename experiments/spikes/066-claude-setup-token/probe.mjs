import {query} from '@anthropic-ai/claude-agent-sdk';
import {InputQueue, api} from '../../../examples/claude-client/common.js';
import {remoteProcess} from '../../../examples/claude-client/node-transport.mjs';

const base=process.argv[2],live=process.argv.includes('--live');
const report={startedAt:new Date().toISOString(),live,sdkVersion:'0.3.296',status:'running',checks:[],submittedTurns:0,results:[],
  billing:'SDK conversation-cumulative cost estimates; sum of final costs by conversation is an upper bound for this new-session probe, not subscription billing'};
const opened=[];
function check(value,label){if(!value)throw Error(label);report.checks.push(label);}
async function until(test,label,timeout=75000){const end=Date.now()+timeout;while(!await test()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,25));}}
async function open(profileId){
  const worker=await api(base,'/api/workers','POST',{profileId,options:{model:'haiku',tools:[],max_turns:2,max_budget_usd:0.06}});
  const input=new InputQueue();const state={worker,input,frames:[],failure:null,closed:false};opened.push(state);
  state.session=query({prompt:input,options:{spawnClaudeCodeProcess:()=>remoteProcess(worker.websocketUrl)}});
  state.pump=(async()=>{try{for await(const frame of state.session)state.frames.push(frame);}catch(error){state.failure=error.name;}})();
  await state.session.initializationResult();
  const commands=await state.session.supportedCommands();
  state.commands=commands.map(c=>c.name);
  return state;
}
async function turn(state,label,expected,acceptFailure=false){
  const prior=state.frames.filter(f=>f.type==='result').length;
  const frameStart=state.frames.length;
  if(report.submittedTurns>=4)throw Error('Probe turn bound exceeded');
  report.submittedTurns++;
  const entry={label,conversationId:state.worker.conversationId,workerId:state.worker.id,subtype:null,
    isError:null,streamFailure:null,cumulativeCostUsd:null,usage:null,modelUsage:null,
    replyMatches:false,assistantModels:[],authFailureObserved:false};
  report.results.push(entry);
  state.input.push(`Reply exactly ${expected}. Do not use tools.`);
  await until(()=>state.failure||state.frames.filter(f=>f.type==='result').length>prior,`${label} timed out`);
  const result=state.frames.filter(f=>f.type==='result').at(-1);
  // Keep only a classification of native auth errors, never raw provider messages
  // or credentials. An unrelated transport failure cannot pass the negative test.
  const errorText=JSON.stringify([result?.errors,result?.result,
    ...state.frames.slice(frameStart).filter(f=>f.type==='assistant').map(f=>({error:f.error,message:f.message}))]);
  Object.assign(entry,{
    subtype:result?.subtype??null,isError:result?.is_error??Boolean(state.failure),streamFailure:state.failure,
    cumulativeCostUsd:result?.total_cost_usd??null,usage:result?.usage??null,modelUsage:result?.modelUsage??null,
    replyMatches:typeof result?.result==='string'&&result.result.trim()===expected,
    assistantModels:[...new Set(state.frames.slice(frameStart).filter(f=>f.type==='assistant').map(f=>f.message?.model).filter(Boolean))],
    authFailureObserved:/\b401\b|authentication_error|invalid (?:api key|bearer|oauth|token|authentication)|authentication (?:failed|failure)|token (?:is )?(?:invalid|expired)|unauthorized/i.test(errorText),
  });
  if(acceptFailure)check((entry.isError||entry.subtype!=='success')&&entry.authFailureObserved,`${label}: native authentication rejection observed`);
  else{
    check(entry.subtype==='success'&&!entry.isError&&entry.replyMatches,`${label}: successful bounded reply`);
    check(entry.assistantModels.length>0&&entry.assistantModels.every(m=>m.toLowerCase().includes('haiku')),`${label}: no model substitution`);
  }
  return entry;
}
async function close(state){
  if(state.closed)return;state.closed=true;state.session?.close();state.input.close();await state.pump;
  await until(async()=>{const status=await api(base,`/api/workers/${state.worker.id}`);return status.state==='stopped';},'Worker did not stop on SDK disconnect',15000);
}
try{
  report.initialAuthStatus=await api(base,'/spike/native-status');
  const a=await open('profile-a'),b=await open('profile-b');
  check(a.worker.conversationId!==b.worker.conversationId,'Independent conversations for separate profiles');
  check(a.commands.some(n=>n.includes('spike-profile-a'))&&!a.commands.some(n=>n.includes('spike-profile-b')),'Profile A exposes only its sentinel command');
  check(b.commands.some(n=>n.includes('spike-profile-b'))&&!b.commands.some(n=>n.includes('spike-profile-a')),'Profile B exposes only its sentinel command');
  await close(b);
  if(live){
    await turn(a,'original token','TOKEN_A_OK');
    await api(base,'/spike/token-mode','POST',{mode:'invalid'});
    report.invalidAuthStatus=await api(base,'/spike/native-status');
    const rejected=await open('profile-b');
    await turn(rejected,'new allocation after invalid replacement','MUST_NOT_SUCCEED',true);
    await close(rejected);
    await turn(a,'existing process after reference changed','TOKEN_A_STILL_OK');
    await api(base,'/spike/token-mode','POST',{mode:'original'});
    const restored=await open('profile-b');
    await turn(restored,'new allocation after restoration','TOKEN_B_OK');
    await close(restored);
  }
  await close(a);
  check((await api(base,'/api/workers')).every(w=>w.state==='stopped'),'SDK disconnect reaps every worker (RC-08)');
  report.status='passed';
}catch(error){report.status='failed';report.failure=String(error.message);}
finally{
  const cleanup=await Promise.allSettled(opened.map(close));
  if(cleanup.some(r=>r.status==='rejected'))report.status='failed';
  const costs=new Map();for(const r of report.results)if(typeof r.cumulativeCostUsd==='number')costs.set(r.conversationId,Math.max(costs.get(r.conversationId)??0,r.cumulativeCostUsd));
  report.reportedCostUpperBoundUsd=[...costs.values()].reduce((a,b)=>a+b,0);
  report.missingResultTurns=report.results.filter(r=>r.subtype===null).length;
  report.endedAt=new Date().toISOString();console.log(JSON.stringify(report));
}
process.exitCode=report.status==='passed'?0:1;

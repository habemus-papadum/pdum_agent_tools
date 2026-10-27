/** Official SDK initialization/control only. This helper has no prompt submission command. */
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';
import {InputQueue} from '../../../examples/claude-client/common.js';
import {remoteProcess} from '../../../examples/claude-client/node-transport.mjs';

const require=createRequire(new URL('../../../examples/claude-client/package.json',import.meta.url));
const {query}=await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href);
const sessions=new Map();
async function handle(command){
  if(command.operation==='open'){
    const input=new InputQueue(),state={input,counts:{},error:null};
    const session=query({prompt:input,options:{spawnClaudeCodeProcess:()=>remoteProcess(command.url)}});
    state.session=session;sessions.set(command.key,state);
    state.pump=(async()=>{try{for await(const frame of session)state.counts[frame.type]=(state.counts[frame.type]??0)+1;}catch(error){state.error=error.name;}})();
    await session.initializationResult();
    return {initialized:true,counts:state.counts};
  }
  const state=sessions.get(command.key);
  if(!state)throw Error('Unknown SDK control connection');
  if(command.operation==='interrupt')await state.session.interrupt();
  else if(command.operation==='close'){state.session.close();state.input.close();await state.pump;}
  else if(command.operation!=='status')throw Error('Only no-input control operations are supported');
  return {counts:state.counts,error:state.error};
}
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
try{
  for await(const line of lines){let command;
    try{command=JSON.parse(line);const result=await handle(command);console.log(JSON.stringify({id:command.id,ok:true,result}));}
    catch(error){console.log(JSON.stringify({id:command?.id,ok:false,error:error.message}));}
  }
}finally{
  for(const state of sessions.values()){state.session.close();state.input.close();}
  await Promise.allSettled([...sessions.values()].map(state=>state.pump));
}

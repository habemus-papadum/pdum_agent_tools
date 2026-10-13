import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { listSessions, getSessionInfo, getSessionMessages, renameSession, forkSession } from "@anthropic-ai/claude-agent-sdk";

// Import-time SDK environment stays fixed for this helper's entire lifetime.
if (!process.env.CLAUDE_CONFIG_DIR || !process.env.SPIKE_STORAGE_WORK || process.env.SPIKE_STORAGE_HELPER !== "1") {
  throw new Error("Explicit profile/workspace required");
}
const dir = resolve(process.env.SPIKE_STORAGE_WORK);
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  let id:unknown;
  try {
    const request=JSON.parse(line) as {id:number;operation:string;sessionId:string;title?:string;upToMessageId?:string};
    id=request.id;
    let result:unknown;
    switch(request.operation){
      case "list":result=await listSessions({dir,includeWorktrees:false});break;
      case "info":result=await getSessionInfo(request.sessionId,{dir})??null;break;
      case "read":result=await getSessionMessages(request.sessionId,{dir});break;
      case "rename":await renameSession(request.sessionId,request.title!,{dir});result=true;break;
      case "fork":result=await forkSession(request.sessionId,{dir,
        ...(request.title===undefined?{}:{title:request.title}),
        ...(request.upToMessageId===undefined?{}:{upToMessageId:request.upToMessageId}),
      });break;
      default:throw new Error("Unknown storage operation");
    }
    process.stdout.write(JSON.stringify({id,ok:true,result})+"\n");
  }catch(error){process.stdout.write(JSON.stringify({id,ok:false,error:error instanceof Error?error.message:String(error)})+"\n");}
}

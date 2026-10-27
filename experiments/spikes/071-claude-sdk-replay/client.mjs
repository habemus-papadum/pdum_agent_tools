/** SDK framing adapter, entirely client-side. The 068 owner is unchanged. */
const NativeWebSocket = globalThis.WebSocket;
export const connections = [];
export function installFeedAdapter({ passiveReplay = false } = {}) {
  globalThis.WebSocket = class FeedSocket {
    static OPEN=1; static CONNECTING=0; static CLOSING=2; static CLOSED=3;
    onopen=null; onmessage=null; onclose=null; onerror=null;
    listeners=new Map();
    addEventListener(type,callback){const list=this.listeners.get(type)??[];list.push(callback);this.listeners.set(type,list);}
    removeEventListener(type,callback){this.listeners.set(type,(this.listeners.get(type)??[]).filter(x=>x!==callback));}
    emit(type,event){this['on'+type]?.(event);for(const callback of this.listeners.get(type)??[])callback(event);}
    constructor(url) {
      this.events=[];this.nativeFrames=[];this.sent=[];this.replaying=true;this.pending='';
      this.socket=new NativeWebSocket(url); connections.push(this);
      this.decoder=new TextDecoder();
      this.socket.onopen=event=>this.emit('open',event);
      this.socket.onclose=event=>this.emit('close',event);
      this.socket.onerror=event=>this.emit('error',event);
      this.socket.onmessage=({data})=>{
        const envelope=JSON.parse(data);this.events.push(envelope);
        if(envelope.kind==='replay-start'){this.replaying=true;return;}
        if(envelope.kind==='replay-end'){this.replaying=false;return;}
        if(envelope.kind==='process-exit'){this.socket.close();return;}
        if(envelope.kind!=='output')return;
        this.pending+=this.decoder.decode(Uint8Array.from(atob(envelope.data),x=>x.charCodeAt(0)),{stream:true});
        for(;;){const index=this.pending.indexOf('\n');if(index<0)break;
          const line=this.pending.slice(0,index);this.pending=this.pending.slice(index+1);if(!line)continue;
          const frame=JSON.parse(line);this.nativeFrames.push({replay:this.replaying,frame});
          // Experimental policy: history remains available to app projection;
          // executable SDK callbacks see only new requests. Fresh initialize
          // re-arms still-pending permissions. No server decision is inserted.
          if(passiveReplay&&this.replaying&&['control_request','control_response','control_cancel_request'].includes(frame.type))continue;
          this.emit('message',{data:line+'\n'});
        }
      };
    }
    get readyState(){return this.socket.readyState;}
    send(text){this.sent.push(text);this.socket.send(text);}
    close(...args){this.socket.close(...args);}
  };
}
export class InputQueue {
  values=[]; waiter=null; ended=false;
  push(value){if(this.waiter){const callback=this.waiter;this.waiter=null;callback({value,done:false});}else this.values.push(value);}
  close(){this.ended=true;this.waiter?.({done:true});this.waiter=null;}
  [Symbol.asyncIterator](){return {next:()=>this.values.length?Promise.resolve({value:this.values.shift(),done:false}):this.ended?Promise.resolve({done:true}):new Promise(resolve=>{this.waiter=resolve;})};}
}
export async function until(predicate, timeout=12000){const start=Date.now();while(!predicate()){if(Date.now()-start>timeout)throw Error('Probe deadline');await new Promise(resolve=>setTimeout(resolve,20));}}
export async function openClient(query,url,options={}) {
  const input=new InputQueue();const messages=[];const errors=[];
  const abortController=options.abortController??new AbortController();
  const timer=setTimeout(()=>abortController.abort(),90000);
  const session=query({prompt:input,websocket:{url},...options,abortController});
  const completion=(async()=>{try{for await(const message of session)messages.push(message);}catch(error){errors.push(String(error));}finally{clearTimeout(timer);}})();
  try{await session.initializationResult();}catch(error){session.close();input.close();clearTimeout(timer);throw error;}
  const socket=connections.at(-1);
  return {session,input,messages,errors,socket,completion,
    send(text){const uuid=crypto.randomUUID();input.push({type:'user',uuid,session_id:'',parent_tool_use_id:null,message:{role:'user',content:text}});return uuid;},
    async close(){session.close();input.close();await completion;},
  };
}

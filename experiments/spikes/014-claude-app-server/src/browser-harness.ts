import "./browser-entry.js";
const state = (globalThis as unknown as {spike014:{send(text:string):void;interrupt():Promise<void>;close():void;frames:unknown[];callbacks:unknown[];initialized:boolean}}).spike014;
const status = document.querySelector("#status")!;
document.querySelector("#interrupt")!.addEventListener("click",()=>{
  void state.interrupt().then(()=>{status.textContent="Interrupt acknowledged";}).catch(error=>{status.textContent=String(error);});
});
document.querySelector("#send")!.addEventListener("click",()=>{
  state.send((document.querySelector("#prompt") as HTMLInputElement).value);
});
document.querySelector("#detach")!.addEventListener("click",()=>{state.close();status.textContent="Detached";});
document.querySelector("#save")!.addEventListener("click",()=>{
  void fetch("/report",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({userAgent:navigator.userAgent,initialized:state.initialized,frames:state.frames,callbacks:state.callbacks})}).then(()=>{status.textContent="Browser evidence saved";});
});

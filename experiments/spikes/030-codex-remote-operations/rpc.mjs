import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
export class Rpc {
  seq=0; pending=new Map(); events=[]; transcript=[];
  constructor(send, close, capture) {this.sendWire=send; this.closeWire=close; this.capture=capture;}
  record(direction,message) {const e={time:new Date().toISOString(),monotonicMs:performance.now(),direction,message}; this.transcript.push(e); if(this.capture) appendFileSync(this.capture,JSON.stringify(e)+'\n');}
  receive(message) {this.record('server',message); if(message.id!==undefined && !message.method) {const p=this.pending.get(message.id); this.pending.delete(message.id); if(message.error) p?.reject(Error(JSON.stringify(message.error))); else p?.resolve(message.result);} else {this.events.push(message); if(message.method && message.id!==undefined) this.send({id:message.id,error:{code:-32601,message:'Probe declines unexpected callback'}});}}
  send(m) {this.record('client',m); this.sendWire(m);}
  async request(method,params={},timeout=15000) {const id=++this.seq; let timer; try {return await new Promise((resolve,reject)=>{timer=setTimeout(()=>{this.pending.delete(id);reject(Error(method+' timeout'));},timeout);this.pending.set(id,{resolve,reject});this.send({id,method,params});});} finally {clearTimeout(timer);}}
  async wait(predicate,timeout=15000) {const until=Date.now()+timeout; while(Date.now()<until) {const e=this.events.find(predicate);if(e)return e;await delay(20);}throw Error('event timeout');}
  close(){this.closeWire();}
  async initialize(experimental=true) {await this.request('initialize',{clientInfo:{name:'spike030',title:'remote operations probe',version:'0.0.0'},capabilities:{experimentalApi:experimental}});this.send({method:'initialized',params:{}});}
  static stdio(binary,home,cwd,capture) {const child=spawn(binary,['app-server','-c','sandbox_mode="danger-full-access"','-c','approval_policy="never"','-c','analytics.enabled=false','-c','feedback.enabled=false','-c','features.apps=false','-c','features.plugins=false','-c','skills.bundled.enabled=false'],{cwd,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,LANG:'en_US.UTF-8'},stdio:['pipe','pipe','pipe']}); const rpc=new Rpc(m=>child.stdin.write(JSON.stringify(m)+'\n'),()=>{child.stdin.end();child.kill('SIGTERM');},capture);rpc.child=child;child.stderr.on('data',b=>{if(capture)appendFileSync(capture+'.stderr',b);});createInterface({input:child.stdout}).on('line',line=>{try{rpc.receive(JSON.parse(line));}catch{}}); return rpc;}
  static async socket(url,capture) {const ws=new WebSocket(url);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});const rpc=new Rpc(m=>ws.send(JSON.stringify(m)),()=>ws.close(),capture);ws.addEventListener('message',e=>rpc.receive(JSON.parse(String(e.data))));return rpc;}
}

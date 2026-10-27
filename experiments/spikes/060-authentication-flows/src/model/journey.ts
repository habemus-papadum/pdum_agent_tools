/** Disposable interaction fixtures. No IO, credential material or production config schema. */
export type Method = 'native' | 'api-key' | 'reuse-login' | 'workforce' | 'bedrock';
export type Outcome = 'success' | 'expired' | 'failure' | 'connection-lost';
export type Step = 'choose' | 'timing' | 'queued' | 'connect' | 'provider' | 'done' | 'failed' | 'expired' | 'unknown' | 'cancelled';
export interface Agent {id: string; title: string; state: 'working' | 'idle'; background?: string;}
export interface Profile {
  id: string; name: string; host: 'atlas.local' | 'workbench.remote'; provider: 'codex' | 'claude';
  family: 'direct' | 'workforce' | 'bedrock'; auth: 'signed-in' | 'expired' | 'missing' | 'unknown' | 'available';
  expiry: string | null; agents: Agent[];
}
export const profiles: readonly Profile[] = [
  {id:'atlas/research',name:'Research',host:'atlas.local',provider:'codex',family:'direct',auth:'signed-in',expiry:'2h left',agents:[{id:'a1',title:'Client toolkit',state:'working'},{id:'a2',title:'Regression sweep',state:'idle',background:'Test runner'}]},
  {id:'atlas/writing',name:'Writing',host:'atlas.local',provider:'claude',family:'direct',auth:'signed-in',expiry:null,agents:[{id:'a3',title:'Design notes',state:'idle'}]},
  {id:'atlas/api',name:'API experiments',host:'atlas.local',provider:'codex',family:'direct',auth:'expired',expiry:'Expired 20m ago',agents:[]},
  {id:'remote/build',name:'Build fleet',host:'workbench.remote',provider:'codex',family:'direct',auth:'expired',expiry:'Expired 5m ago',agents:[{id:'a4',title:'Runtime evaluation',state:'working'},{id:'a5',title:'Protocol audit',state:'working'}]},
  {id:'remote/review',name:'Review',host:'workbench.remote',provider:'claude',family:'direct',auth:'missing',expiry:null,agents:[{id:'a6',title:'Review queue',state:'idle'}]},
  {id:'remote/team',name:'Organization access',host:'workbench.remote',provider:'codex',family:'workforce',auth:'unknown',expiry:null,agents:[]},
  {id:'remote/aws',name:'Bedrock workers',host:'workbench.remote',provider:'claude',family:'bedrock',auth:'available',expiry:'55m left',agents:[{id:'a7',title:'Batch classification',state:'working'}]},
];
export const hosts = ['atlas.local','workbench.remote'] as const;
export const methodInfo: Record<Method,{title:string; description:string; icon:string}> = {
  native:{title:'Sign in with an account',description:'Continue in your browser.',icon:'↗'},
  'api-key':{title:'Use an API key',description:'Choose a key source on this machine.',icon:'⌘'},
  'reuse-login':{title:'Reuse an existing login',description:'Choose an account already on this machine.',icon:'↔'},
  workforce:{title:'Sign in through your organization',description:'Workforce Federation · exploratory',icon:'◇'},
  bedrock:{title:'Use AWS credentials',description:'Bedrock · exploratory',icon:'▧'},
};
export function methodsFor(profile: Profile): Method[] { return profile.family === 'direct' ? ['native','api-key','reuse-login'] : [profile.family]; }
export function authLabel(profile: Profile): string { return ({'signed-in':'Sign-in reported',expired:'Expired',missing:'Sign in needed',unknown:'Unknown',available:'Credential available'})[profile.auth]; }
export function working(profile: Profile): number { return profile.agents.filter(a=>a.state==='working').length; }
export function withIdleAgents(profile: Profile): Profile {return {...profile,agents:profile.agents.map(a=>({...a,state:'idle'}))};}
export interface Draft {apiKeyEnv:string; source:string; awsSource:'sso'|'role';}
export interface Flow {id:number; profile:Profile; method:Method; draft:Draft; step:Step; timing:'now'|'idle'|null; outcome:Outcome; access:'untested'|'passed'|'denied';}
export function prepare(profile: Profile, id:number): Flow {return {id,profile:structuredClone(profile),method:methodsFor(profile)[0],draft:{apiKeyEnv:profile.provider==='codex'?'OPENAI_API_KEY':'ANTHROPIC_API_KEY',source:'Operator login',awsSource:'sso'},step:'choose',timing:null,outcome:'success',access:'untested'};}
export function configure(flow:Flow, method:Method, draft:Draft, outcome:Outcome):Flow {
  if(flow.step!=='choose') return flow;
  if(!methodsFor(flow.profile).includes(method)) throw new Error('Method does not belong to this profile');
  return {...flow,method,draft:{...draft},outcome,step:working(flow.profile)?'timing':'connect',timing:working(flow.profile)?null:'now'};
}
export function schedule(flow:Flow,timing:'now'|'idle'):Flow {return flow.step==='timing'?{...flow,timing,step:timing==='idle'&&working(flow.profile)>0?'queued':'connect'}:flow;}
export function agentsBecameIdle(flow:Flow):Flow {return flow.step==='queued'?{...flow,profile:withIdleAgents(flow.profile),step:'connect'}:flow;}
export function usesBrowser(flow:Flow):boolean {return flow.method==='native'||flow.method==='workforce'||(flow.method==='bedrock'&&flow.draft.awsSource==='sso');}
export function openBrowser(flow:Flow):Flow {return flow.step==='connect'&&usesBrowser(flow)?{...flow,step:'provider'}:flow;}
export function complete(flow:Flow):Flow {
  if(flow.step!=='provider' && !(flow.step==='connect'&&!usesBrowser(flow))) return flow;
  const step: Step = ({success:'done',expired:'expired',failure:'failed','connection-lost':'unknown'} as const)[flow.outcome];
  return {...flow,step};
}
export function pending(flow:Flow):boolean {return ['choose','timing','queued','connect','provider'].includes(flow.step);}
export function cancel(flow:Flow):Flow {
  if(!pending(flow)) return flow;
  const sent = ['connect','provider'].includes(flow.step);
  return {...flow,step:sent&&flow.profile.host==='workbench.remote'?'unknown':'cancelled'};
}
export function validate(flow:Flow,outcome:'passed'|'denied'):Flow {return flow.step==='done'?{...flow,access:outcome}:flow;}
export function resultProfile(flow:Flow):Profile|null {return flow.step==='done'?{...flow.profile,auth:flow.method==='native'||flow.method==='workforce'?'signed-in':'available',expiry:null}:null;}
export const stepLabel:Record<Step,string>={choose:'Choose how to sign in',timing:'Agents are using this profile',queued:'Waiting for agents to become idle',connect:'Connect your account',provider:'Finish in the browser',done:'Authentication updated',failed:'Authentication did not complete',expired:'Sign-in expired',unknown:'Host result unknown',cancelled:'Authentication cancelled'};

import {action, control, scope} from '@habemus-papadum/aiui-viz';
import {agentsBecameIdle, cancel as cancelFlow, complete as completeFlow, configure, openBrowser, pending, prepare, profiles, resultProfile, schedule, validate, type Flow, type Method, type Outcome, type Profile} from './journey';
export const appScope = scope('orchestrator-auth');
/** Profile to inspect. Identity includes its machine; changing methods never changes this target. */
export const selected = control({scope:appScope,value:profiles[0].id,options:profiles.map(p=>p.id)});
/** Draft authentication method. The selected profile determines which choices can be submitted. */
export const method = control<Method>({scope:appScope,value:'native',options:['native','api-key','reuse-login','workforce','bedrock']});
/** Fixture environment reference only; credentials are never entered in this mock. */
export const apiKeyEnv = control({scope:appScope,value:'OPENAI_API_KEY',options:['OPENAI_API_KEY','ANTHROPIC_API_KEY','TEAM_PROVIDER_KEY']});
/** Existing login on the target machine, represented by a fictional source name. */
export const sourceLogin = control({scope:appScope,value:'Operator login',options:['Operator login','Research login']});
/** Explore AWS SSO versus a machine role; neither adapter is implemented by this page. */
export const awsSource = control<'sso'|'role'>({scope:appScope,value:'sso',options:['sso','role']});
/** Failure injection outside the proposed application; captured when Continue is pressed. */
export const scenario = control<Outcome>({scope:appScope,value:'success',options:['success','expired','failure','connection-lost']});
/** Independent model-access outcome, separate from completing authentication. */
export const accessOutcome = control<'passed'|'denied'>({scope:appScope,value:'passed',options:['passed','denied']});
/** Show the reviewer's commentary beside the application mock. */
export const notesOpen = control({scope:appScope,value:true});
export const flow = appScope.durableSignal<Flow|null>('profile-journey-v2',null);
export const updates = appScope.durableSignal<Record<string,Profile>>('profile-updates-v2',{});
const sequence = appScope.durableSignal('attempt-sequence-v2',0);
export function currentProfile():Profile {return updates.get()[selected.get()] ?? profiles.find(p=>p.id===selected.get())!;}
function change(fn:(f:Flow)=>Flow) {flow.set(f=>f?fn(f):null);}
/** Start a sign-in journey for the selected profile; freeze its identity across later selection changes. */
export const start = action({scope:appScope,name:'authenticate',group:'authentication',run:()=>{
  if(flow.get()) return;
  const next=prepare(currentProfile(),sequence.get()+1); sequence.set(next.id); method.set(next.method); apiKeyEnv.set(next.draft.apiKeyEnv); sourceLogin.set('Operator login'); awsSource.set('sso'); flow.set(next);
}});
/** Submit the chosen method, then ask about timing if this profile has working agents. */
export const proceed = action({scope:appScope,name:'continue',group:'authentication',run:()=>change(f=>configure(f,method.get(),{apiKeyEnv:apiKeyEnv.get(),source:sourceLogin.get(),awsSource:awsSource.get()},scenario.get()))});
/** Explicit illustrative timing choice, not a promise of safe live credential replacement. */
export const chooseTiming = action({scope:appScope,name:'choose-timing',group:'authentication',params:{timing:'now or idle'},run:args=>{
  if(args?.timing!=='now'&&args?.timing!=='idle') throw new Error('Choose now or idle');
  const timing=args.timing; change(f=>schedule(f,timing));
}});
/** Study-only event: working agents become idle; background jobs remain listed. */
export const settleAgents = action({scope:appScope,name:'agents-idle',group:'study',run:()=>{
  const f=flow.get(); if(!f||f.step!=='queued')return;
  const next=agentsBecameIdle(f); updates.set(all=>({...all,[next.profile.id]:next.profile})); flow.set(next);
}});
/** Open an in-page fictional sign-in window. Never navigate to a provider. */
export const signIn = action({scope:appScope,name:'open-sign-in',group:'authentication',run:()=>change(openBrowser)});
/** Complete the fictional provider or credential-source step with its frozen study outcome. */
export const complete = action({scope:appScope,name:'complete-sign-in',group:'authentication',run:()=>{
  const f=flow.get();if(!f)return; const next=completeFlow(f); const profile=resultProfile(next);
  if(profile) updates.set(all=>({...all,[profile.id]:profile})); flow.set(next);
}});
/** Stop this mock journey. A sent remote attempt keeps its outcome unknown. */
export const cancel = action({scope:appScope,name:'cancel',group:'authentication',run:()=>change(cancelFlow)});
/** Optional independent access check; the result is a fixture, not a billed request. */
export const validateAccess = action({scope:appScope,name:'test-access',group:'authentication',run:()=>change(f=>validate(f,accessOutcome.get()))});
/** Return to profile inventory after a terminal result; no launch happens. */
export const finish = action({scope:appScope,name:'back-to-profiles',group:'navigation',run:()=>{const f=flow.get();if(f&&!pending(f)){selected.set(f.profile.id);flow.set(null);}}});
/** Reset fixture state in this tab; never touches a machine. */
export const reset = action({scope:appScope,name:'reset',group:'study',run:()=>{
  flow.set(null);updates.set({});sequence.set(0);selected.set(profiles[0].id);method.set('native');apiKeyEnv.set('OPENAI_API_KEY');sourceLogin.set('Operator login');awsSource.set('sso');scenario.set('success');accessOutcome.set('passed');
}});

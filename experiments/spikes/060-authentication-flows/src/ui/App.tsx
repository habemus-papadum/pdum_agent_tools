import {CellView, ControlSelect} from '@habemus-papadum/aiui-viz';
import {For, Show, onCleanup} from 'solid-js';
import {CommandPalette, type Command} from '../../../055-orchestrator-mock-lab/shared/CommandPalette';
import {graph} from '../model/graph';
import {authLabel, hosts, methodInfo, methodsFor, pending, stepLabel, usesBrowser, working, type Flow, type Profile} from '../model/journey';
import * as s from '../model/store';

function Status(props:{profile:Profile}) {return <span class={`auth-status state-${props.profile.auth}`}><i/>{authLabel(props.profile)}</span>;}
function AgentList(props:{profile:Profile}) {return <div class="auth-agents"><For each={props.profile.agents} keyed={a=>a.id} fallback={<p class="auth-quiet">No agents use this profile.</p>}>{agent=><div class="auth-agent"><span class={`auth-agent-dot ${agent().state}`}/><strong>{agent().title}</strong><span>{agent().state}</span><Show when={agent().background}><small title="An idle agent can still own background work">↳ {agent().background} running</small></Show></div>}</For></div>;}
function ProfileRow(props:{profile:Profile}) {return <button class="auth-profile-row" aria-pressed={s.selected.get()===props.profile.id?'true':'false'} onClick={()=>s.selected.set(props.profile.id)}><span class="auth-profile-name"><b>{props.profile.provider==='codex'?'◇':'✳'}</b><strong>{props.profile.name}</strong><small>{props.profile.provider}</small></span><Status profile={props.profile}/><span class="auth-row-meta"><span>{props.profile.agents.length} agents · {working(props.profile)} working</span><span title="Illustrative credential expiry; not an agent lifetime or proven refresh deadline">{props.profile.expiry??'Expiry unknown'}</span></span></button>;}
function Inventory() {return <CellView of={graph().inventory} label="Machine and profile inventory">{rows=><nav class="auth-inventory" aria-label="Machines and profiles"><For each={hosts}>{host=><section class="auth-machine"><header><span>▣</span><strong>{host}</strong><small>{host==='atlas.local'?'local':'remote'}</small></header><For each={rows().filter(p=>p.host===host)} keyed={p=>p.id}>{profile=><ProfileRow profile={profile()}/>}</For></section>}</For></nav>}</CellView>;}
function ProfileDetail(props:{profile:Profile}) {return <section class="auth-profile-detail">
  <div class="auth-breadcrumb">{props.profile.host} <span>/</span> {props.profile.provider}</div>
  <h2>{props.profile.name}</h2><div class="auth-detail-status"><Status profile={props.profile}/><span title="Fixture snapshot. Token expiry does not necessarily mean another sign-in is needed.">{props.profile.expiry??'Expiry unknown'}</span></div>
  <Show when={props.profile.family!=='direct'}><p class="auth-exploratory">{props.profile.family==='workforce'?'Workforce Federation':'AWS Bedrock'} · exploratory flow</p></Show>
  <div class="auth-actions"><button class="auth-primary" onClick={()=>s.start.run()}>Authenticate profile <span>↗</span></button></div>
  <h3>Agents using this profile <span>{props.profile.agents.length}</span></h3><AgentList profile={props.profile}/>
  <p class="auth-quiet">One profile can be shared by several agents. Authentication is managed here.</p>
</section>;}
function ProviderWindow(props:{flow:Flow}) {
  let approve!:HTMLButtonElement; let previous:HTMLElement|null=null;
  previous=document.activeElement as HTMLElement;
  queueMicrotask(()=>approve?.isConnected && approve.focus());
  onCleanup(()=>{if(previous?.isConnected)previous.focus();});
  const service=()=>props.flow.method==='workforce'?'Organization sign-in':props.flow.method==='bedrock'?'AWS sign-in':props.flow.profile.provider==='codex'?'OpenAI account':'Claude account';
  return <div class="auth-provider-backdrop" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();s.cancel.run();}}}>
    <section class="auth-provider-window" role="dialog" aria-modal="true" aria-label="Fictional sign-in window"><header><span>◦ ◦ ◦</span><small>Fictional browser window</small><button onClick={()=>s.cancel.run()} title="Close sign-in">×</button></header>
      <div class="auth-provider-body"><span class="auth-service-icon">{methodInfo[props.flow.method].icon}</span><h2>{service()}</h2><p>Sign in to use <strong>{props.flow.profile.name}</strong> on <strong>{props.flow.profile.host}</strong>.</p>
        <div class="auth-account"><b>N</b><span>Example operator<small>operator@example.invalid</small></span></div>
        <Show when={props.flow.profile.host==='workbench.remote'}><p class="auth-link-code">Pairing code <code>DEMO-24</code></p></Show>
        <button ref={approve} class="auth-primary" onClick={()=>s.complete.run()}>Approve and return ↗</button><p class="auth-quiet">UI sketch only. No account or provider is contacted.</p>
      </div>
    </section>
  </div>;
}
function Journey(props:{flow:Flow}) {
  const f=()=>props.flow;
  const failureText=()=>({failed:'The selected account or credential source could not be used.',expired:'This sign-in attempt expired. Return to the profile to start again.',unknown:'The connection ended before the host result was confirmed. Check the host before trying again.',cancelled:'The journey has ended. No agent was launched or stopped.'})[f().step as 'failed'|'expired'|'unknown'|'cancelled'];
  return <section class={`auth-journey step-${f().step}`}>
    <div class="auth-breadcrumb">{f().profile.host} <span>/</span> {f().profile.name}<small>{f().profile.provider}</small></div>
    <div class="auth-step-track"><span class={f().step==='choose'?'current':''}>1 Method</span><i/><span class={['timing','queued','connect','provider'].includes(f().step)?'current':''}>2 Authenticate</span><i/><span class={!pending(f())?'current':''}>3 Result</span></div>
    <h2>{stepLabel[f().step]}</h2>
    <Show when={f().step==='choose'}>
      <div class="auth-methods"><For each={methodsFor(f().profile)}>{method=><button aria-pressed={s.method.get()===method?'true':'false'} onClick={()=>s.method.set(method)}><b>{methodInfo[method].icon}</b><span><strong>{methodInfo[method].title}</strong><small>{methodInfo[method].description}</small></span><span class="auth-radio"/></button>}</For></div>
      <Show when={s.method.get()==='api-key'}><div class="auth-field"><ControlSelect of={s.apiKeyEnv} label="Key source on this machine"/><small>Environment reference · fixture names</small></div></Show>
      <Show when={s.method.get()==='reuse-login'}><div class="auth-field"><ControlSelect of={s.sourceLogin} label="Existing login on this machine"/></div></Show>
      <Show when={s.method.get()==='bedrock'}><div class="auth-field"><ControlSelect of={s.awsSource} label="AWS source (sso = browser; role = machine)"/><small>Account: Example team · Region: us-east-1</small></div></Show>
      <div class="auth-actions"><button class="auth-primary" disabled={!methodsFor(f().profile).includes(s.method.get())} onClick={()=>s.proceed.run()}>Continue →</button><button onClick={()=>s.cancel.run()}>Cancel</button></div>
    </Show>
    <Show when={f().step==='timing'}>
      <p>{working(f().profile)} agents are working. When would you like to authenticate?</p><AgentList profile={f().profile}/>
      <div class="auth-timing"><button onClick={()=>s.chooseTiming.run({timing:'now'})}><strong>Continue now →</strong><small>Explore authentication while work continues.</small></button><button onClick={()=>s.chooseTiming.run({timing:'idle'})}><strong>Wait for idle ◷</strong><small>Explore waiting for current turns to finish.</small></button></div>
      <button onClick={()=>s.cancel.run()}>Cancel</button>
    </Show>
    <Show when={f().step==='queued'}><div class="auth-wait"><span class="auth-orbit">◷</span><p>The request stays with <strong>{f().profile.name}</strong> until its working agents become idle.</p></div><AgentList profile={f().profile}/><button onClick={()=>s.cancel.run()}>Cancel waiting</button></Show>
    <Show when={f().step==='connect'}>
      <div class="auth-route"><span>◉ This browser</span><i>→</i><span>▣ {f().profile.host}</span><i>→</i><span>◇ {f().profile.name}</span></div>
      <Show when={f().profile.agents.some(agent=>agent.background)}><p class="auth-quiet">A background job is still running: {f().profile.agents.filter(agent=>agent.background).map(agent=>agent.background).join(', ')}.</p></Show>
      <Show when={usesBrowser(f())} fallback={<>
        <p>{f().method==='api-key'?'Use the API key available through':f().method==='reuse-login'?'Use credentials from':'Use the machine’s AWS role:'} <strong>{f().method==='api-key'?f().draft.apiKeyEnv:f().method==='reuse-login'?f().draft.source:'Example worker role'}</strong>.</p>
        <p class="auth-quiet">Source and target are on {f().profile.host}.</p><button class="auth-primary" onClick={()=>s.complete.run()}>{f().method==='api-key'?'Use this key source':f().method==='reuse-login'?'Use this login':'Use this role'} →</button>
      </>}>
        <p>Complete sign-in in your browser. The result belongs to <strong>{f().profile.name}</strong> on <strong>{f().profile.host}</strong>.</p>
        <Show when={f().profile.host==='workbench.remote'}><div class="auth-code-card"><span>Remote sign-in pairing</span><code>DEMO-24</code><small>Illustrative handoff</small></div></Show>
        <button class="auth-primary" onClick={()=>s.signIn.run()}>Open sign-in window ↗</button>
      </Show>
      <div class="auth-actions"><button onClick={()=>s.cancel.run()}>{f().profile.host==='workbench.remote'?'Stop watching':'Cancel'}</button></div>
    </Show>
    <Show when={f().step==='provider'}><p>Waiting for the sign-in window…</p><ProviderWindow flow={f()}/></Show>
    <Show when={f().step==='done'}>
      <div class="auth-result"><span class="auth-result-icon">✓</span><p><strong>{f().profile.name}</strong> on {f().profile.host}<small>{f().method==='native'||f().method==='workforce'?'Sign-in reported':'Credential source available'} · expiry unknown</small></p></div>
      <p class="auth-quiet">No agents have been restarted.</p>
      <div class="auth-access"><span>Model access <strong>{f().access==='untested'?'Not tested':f().access==='passed'?'Test passed':'Access denied'}</strong></span><Show when={f().access==='untested'}><button onClick={()=>s.validateAccess.run()}>Test model access</button></Show></div>
      <button class="auth-primary" onClick={()=>s.finish.run()}>Back to profiles →</button>
    </Show>
    <Show when={['failed','expired','unknown','cancelled'].includes(f().step)}><p>{failureText()}</p><button class="auth-primary" onClick={()=>s.finish.run()}>Back to profiles →</button></Show>
  </section>;
}
function Commentary() {
  return <aside class="auth-commentary" aria-label="Commentary outside the application mock"><span class="auth-eyebrow">Review commentary</span><h2>What this flow is exploring</h2><p>Machine → profile → agents. A profile owns an authentication choice; several agents can share it.</p>
    <Show when={s.flow.get()} fallback={<p>Choose a profile, inspect who is using it, then try “Authenticate profile”. The result returns to the same profile.</p>}>{f=><p>{f().step==='queued'?'Waiting is an illustrative choice. Use Study controls → Make agents idle to continue. Background jobs are deliberately left running.':f().profile.host==='workbench.remote'?'Here, you sign in locally on behalf of a remote profile. The mock shows the desired experience; the actual link, code and callback mechanism needs a provider-specific spike.':'This journey keeps the target machine and profile fixed. Changing the selection behind it cannot redirect an attempt.'}</p>}</Show>
    <details open><summary>Questions before live integration</summary><ol>
      <li><strong>Running agents.</strong> Can they keep working during authentication? When do they read new credentials? Is idle sufficient if a job or child agent is still running?</li>
      <li><strong>Remote sign-in.</strong> For Codex and Claude separately, how do a browser link, code or callback complete on the initiating host? What survives a lost connection?</li>
      <li><strong>Expiry and refresh.</strong> Which expiry is observable? Does it mean an access token, a login, or a key expires? Who refreshes it?</li>
      <li><strong>Organization and cloud.</strong> What does Workforce Federation configure? How do AWS SSO, machine roles and Bedrock fit the owning launcher?</li>
    </ol></details>
    <details><summary>What the mock assumes</summary><p>All machines, agents, accounts and times are fixtures. “Test model access” is also simulated. No login, profile write, credential read or API request occurs.</p><p>Waiting for idle is an alternative to evaluate, not a chosen policy. A token expiry does not establish that the account needs another sign-in.</p><p>Workforce Federation and Bedrock are exploratory. The existing Codex AWS workload-federation helper is a different mechanism.</p><p>Codex login reuse currently copies auth during profile creation; Claude borrows a token. Updating these existing profiles from this UI needs more work.</p></details>
    <a href="./README.md">Full questions &amp; existing operation map ↗</a>
  </aside>;
}
export function App() {
  const commands:Command[]=[
    {id:'authenticate',group:'profile',label:'Authenticate profile',key:'a',icon:'↗',enabled:()=>!s.flow.get(),run:()=>s.start.run()},
    {id:'continue',group:'profile',label:'Continue with method',key:'n',icon:'→',enabled:()=>s.flow.get()?.step==='choose'&&methodsFor(s.flow.get()!.profile).includes(s.method.get()),run:()=>s.proceed.run()},
    {id:'cancel',group:'profile',label:'Cancel / stop watching',key:'c',icon:'×',enabled:()=>!!s.flow.get()&&pending(s.flow.get()!),run:()=>s.cancel.run()},
    {id:'commentary',group:'study',label:'Toggle commentary',key:'i',icon:'ⓘ',run:()=>s.notesOpen.set(!s.notesOpen.get())},
    {id:'reset',group:'study',label:'Reset fixtures',key:'r',icon:'↺',run:()=>s.reset.run()},
  ];
  return <main class="auth-app">
    <header class="auth-labbar"><a href="/">← Interaction lab</a><span>060 · Profile authentication <b>MOCK</b></span><button aria-pressed={s.notesOpen.get()?'true':'false'} onClick={()=>s.notesOpen.set(!s.notesOpen.get())}>Commentary ⓘ</button>
      <details class="auth-study"><summary>Study controls ◇</summary><div><h3>Script the next result</h3><ControlSelect of={s.scenario} label="Authentication outcome"/><ControlSelect of={s.accessOutcome} label="Model-access outcome"/><button disabled={s.flow.get()?.step!=='queued'} onClick={()=>s.settleAgents.run()}>Make agents idle</button><button onClick={()=>s.reset.run()}>Reset fixtures</button><p>All data and actions are simulated. No credentials or machines are touched.</p></div></details>
    </header>
    <div class={`auth-workspace ${s.notesOpen.get()?'':'notes-hidden'}`}><section class="auth-product" aria-label="Proposed application"><header class="auth-productbar"><h1>Machines &amp; profiles</h1><span>2 machines · 7 profiles · 7 agents</span></header><div class="auth-productbody"><Inventory/><div class="auth-detail-scroll"><CellView of={graph().journey} label="Authentication journey">{journey=><Show when={journey().flow} fallback={<CellView of={graph().detail} label="Selected profile">{profile=><ProfileDetail profile={profile()}/>}</CellView>}>{f=><Journey flow={f()}/>}</Show>}</CellView></div></div></section><Show when={s.notesOpen.get()}><Commentary/></Show></div>
    <CommandPalette scope="orchestrator-auth" commands={commands}/>
  </main>;
}

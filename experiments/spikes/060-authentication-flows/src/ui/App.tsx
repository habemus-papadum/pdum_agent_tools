import {CellView, ControlSelect, ControlToggle} from '@habemus-papadum/aiui-viz';
import {For, Show} from 'solid-js';
import {CommandPalette, type Command} from '../../../055-orchestrator-mock-lab/shared/CommandPalette';
import {active, type OperationPreview, type Provider, type Strategy} from '../model/auth';
import {graph} from '../model/graph';
import * as s from '../model/store';

const strategies: {id: Strategy; icon: string; title: string; description: string}[] = [
  {id: 'api-key', icon: '⌘', title: 'API key reference', description: 'Resolve a variable on the owning host.'},
  {id: 'reuse-login', icon: '↗', title: 'Reuse existing login', description: 'Explicit source, provider-specific behavior.'},
  {id: 'native', icon: '◎', title: 'Dedicated native login', description: 'Let the provider own its credential store.'},
];
function chooseProvider(provider: Provider) { s.provider.set(provider); s.apiKeyEnv.set(provider === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'); }
function Ownership(props: {plan: OperationPreview}) {
  return <section class="auth-ownership" aria-label="Credential ownership">
    <div class="auth-owner-step"><span class="auth-step">01</span><div><span class="auth-eyebrow">Operator surface</span><strong>This browser</strong><small>Simulation controls only</small></div></div>
    <span class="auth-arrow" aria-hidden="true">→</span>
    <div class="auth-owner-step"><span class="auth-step">02</span><div><span class="auth-eyebrow">Host process owner</span><strong>{props.plan.owner}</strong><small>{props.plan.profile.label}</small></div></div>
    <span class="auth-arrow" aria-hidden="true">→</span>
    <div class="auth-owner-step"><span class="auth-step">03</span><div><span class="auth-eyebrow">Result belongs here</span><strong>{props.plan.profile.hostLabel}</strong><small>Native profile / owned child</small></div></div>
  </section>;
}
function Preview(props: {plan: OperationPreview}) {
  return <section class="auth-preview" aria-label="Read-only operation preview">
    <header><span class="auth-eyebrow">Read-only operation preview</span><span class="auth-tag">Source inspected · 19 Oct 2026</span></header>
    <p class="auth-execution">Would execute in the <strong>{props.plan.profile.hostLabel}</strong> terminal, from the repository root.</p>
    <code class="auth-command">{props.plan.command}</code>
    <details class="auth-source-map"><summary>Configuration owner &amp; setup provenance</summary>
      <p>{props.plan.setupMeaning}</p><pre>{props.plan.setup}</pre>
      <span class="auth-eyebrow">Existing library operation</span><code>{props.plan.operation}</code>
      <ul><For each={props.plan.fields}>{field => <li><code>{field}</code></li>}</For></ul>
      <p>These are existing launcher fields. This mock neither creates a configuration schema nor saves the choices.</p>
    </details>
    <details class="auth-source-map"><summary>Native status is a separate observation</summary><pre>{props.plan.status}</pre>
      <p>{props.plan.selection.provider === 'codex' ? 'Codex auth status describes configuration and auth-file presence. Its authenticated value is “not checked”.' : 'Claude auth status invokes the native command in the selected profile environment. logged_in is not proof of inference or token refresh.'}</p>
    </details>
    <p class="auth-caveat">{props.plan.caveat}</p>
  </section>;
}
function Progress() {
  return <CellView of={graph().progress} label="Simulated authentication receipt">{progress => <section class={`auth-progress phase-${progress().phase} access-${progress().access}`} aria-label="Simulation receipt" aria-live="polite">
    <header><span class="auth-eyebrow">Attempt {progress().attempt || '—'} · simulation</span><span class="auth-dot"/></header>
    <h2>{progress().label}</h2>
    <Show when={progress().plan} fallback={<p>The selected fixture already exists. Start previews native login or authentication inspection; setup commands stay read-only.</p>}>
      <p class="auth-frozen-target">Frozen target · <strong>{progress().plan?.profile.id}</strong></p>
      <Show when={progress().plan?.profile.id !== graph().preview.latest()?.profile.id}><p class="auth-caveat">The selector now describes another profile. This receipt still belongs to its original target.</p></Show>
      <div class="auth-evidence"><div><span class="auth-eyebrow">Authentication evidence</span><strong>{progress().presence}</strong></div><div><span class="auth-eyebrow">Model access</span><strong>{progress().access}</strong></div></div>
      <ol class="auth-events"><For each={progress().events}>{event => <li>{event}</li>}</For></ol>
    </Show>
    <div class="auth-actions">
      <button class="auth-primary" disabled={active(s.receipt.get())} onClick={() => s.start.run()}>{progress().attempt ? 'Start fresh simulation' : 'Start simulation'}</button>
      <button disabled={!active(s.receipt.get())} onClick={() => s.advance.run()}>{progress().phase === 'returned' ? 'Observe native status' : 'Advance response'}</button>
      <button disabled={!active(s.receipt.get())} onClick={() => s.cancel.run()}>{progress().plan?.selection.host === 'remote' ? 'Stop watching' : 'Cancel attempt'}</button>
    </div>
    <Show when={progress().phase === 'observed'}><div class="auth-model-check"><p>Credential presence is one observation. A model request is a separate action with its own access and billing.</p><button onClick={() => s.validate.run()}>Simulate model-access check</button><small>Outcome: {s.accessOutcome.get()} · zero provider calls / zero spend</small></div></Show>
    <Show when={progress().phase === 'unknown'}><p class="auth-caveat">Remote result / cancellation remains unconfirmed. A future coordinator must reconcile the host before replay; this study provides no remote completion endpoint.</p></Show>
  </section>}</CellView>;
}
export function App() {
  const commands: Command[] = [
    {id: 'start', group: 'authentication', label: 'Start simulation', key: 'n', icon: '▶', description: 'Freeze the chosen profile and simulate one attempt.', enabled: () => !active(s.receipt.get()), run: () => s.start.run()},
    {id: 'advance', group: 'authentication', label: 'Advance response', key: 'a', icon: '→', description: 'Advance one fixture result, then observe status.', enabled: () => active(s.receipt.get()), run: () => s.advance.run()},
    {id: 'cancel', group: 'authentication', label: 'Cancel / stop watching', key: 'c', icon: '×', description: 'Remote cancellation leaves the host outcome unknown.', enabled: () => active(s.receipt.get()), run: () => s.cancel.run()},
    {id: 'validate', group: 'authentication', label: 'Simulate model access', key: 'v', icon: '◇', description: 'Separate access outcome; no inference call.', enabled: () => s.receipt.get().phase === 'observed', run: () => s.validate.run()},
    {id: 'reset', group: 'study', label: 'Reset study', key: 'r', icon: '↺', description: 'Reset the local synthetic choices and receipt.', run: () => s.reset.run()},
  ];
  return <main class="auth-app">
    <header class="auth-topbar"><div><a href="/">← mock lab</a><span class="auth-eyebrow">060 · authentication</span></div>
      <details class="auth-study"><summary>Study controls <span>◇</span></summary><div><h2>Script the response</h2>
        <ControlSelect of={s.scenario} label="Next attempt outcome"/><ControlSelect of={s.accessOutcome} label="Model-access outcome"/>
        <p>Outcomes are frozen at start. Everything in this study is synthetic; no credentials, login, profile writes or API calls.</p><button onClick={() => s.reset.run()}>Reset simulation</button>
      </div></details>
    </header>
    <div class="auth-heading"><div><h1>Where the login belongs</h1><p>Choose the host and native profile before following an authentication flow.</p></div><span class="auth-simulation">SIMULATION · no live operations</span></div>
    <div class="auth-layout"><aside class="auth-selection" aria-label="Authentication choices">
      <span class="auth-eyebrow">Provider</span><div class="auth-provider-tabs">
        <button aria-pressed={s.provider.get() === 'codex' ? 'true' : 'false'} onClick={() => chooseProvider('codex')}>◇ Codex</button>
        <button aria-pressed={s.provider.get() === 'claude' ? 'true' : 'false'} onClick={() => chooseProvider('claude')}>✳ Claude</button>
      </div>
      <span class="auth-eyebrow">Profile host</span><div class="auth-host-options">
        <button aria-pressed={s.host.get() === 'local' ? 'true' : 'false'} onClick={() => s.host.set('local')}><strong>atlas.local</strong><small>Local · operator</small></button>
        <button aria-pressed={s.host.get() === 'remote' ? 'true' : 'false'} onClick={() => s.host.set('remote')}><strong>workbench.remote</strong><small>Remote · operator</small></button>
      </div>
      <span class="auth-eyebrow">Strategy / prepared fixture profile</span><div class="auth-strategies"><For each={strategies}>{item => <button aria-pressed={s.strategy.get() === item.id ? 'true' : 'false'} onClick={() => s.strategy.set(item.id)}><span class="auth-strategy-icon">{item.icon}</span><span><strong>{item.title}</strong><small>{item.description}</small></span></button>}</For></div>
      <Show when={s.strategy.get() === 'api-key'}><div class="auth-reference"><ControlSelect of={s.apiKeyEnv} label="Environment reference"/><p>Fixture variable names only. Resolve the value on the selected host through its existing credential workflow.</p></div></Show>
      <Show when={s.strategy.get() === 'native' && s.provider.get() === 'codex'}><ControlToggle of={s.deviceAuth} label="Use native device authentication"/></Show>
      <p class="auth-selection-note">Each choice selects a prepared synthetic profile. Full profile creation and editing belongs to the next round.</p>
    </aside><div class="auth-work">
      <CellView of={graph().preview} label="Launcher operation preview">{preview => <>
        <div class="auth-profile"><span class="auth-eyebrow">Selected native profile</span><strong>{preview().profile.label}</strong><code>{preview().profile.path}</code></div>
        <Ownership plan={preview()}/>
        <div class="auth-locations"><div><span class="auth-eyebrow">Credential source</span><p>{preview().credentialSource}</p></div><div><span class="auth-eyebrow">Browser interaction</span><p>{preview().browser}</p></div><div><span class="auth-eyebrow">Result / storage owner</span><p>{preview().result}</p></div><div><span class="auth-eyebrow">Refresh responsibility</span><p>{preview().refresh}</p></div></div>
        <Show when={preview().remoteProposal}><p class="auth-remote">Remote coordination is a proposal. These are host-local CLI operations on workbench.remote; this page does not forward a URL, code or credential to that host. Completion, reconnect and cancellation need live qualification.</p></Show>
        <Preview plan={preview()}/>
      </>}</CellView>
      <Progress/>
    </div></div>
    <footer class="auth-footer">Source owners: pdum.codex_launcher / pdum.claude_launcher · native configuration retained · fixture evidence only <a href="./README.md">Operation map &amp; review notes ↗</a></footer>
    <CommandPalette scope="orchestrator-auth" commands={commands}/>
  </main>;
}

import {For, isPending, Loading, Show} from 'solid-js';
import {bridgeEffect, CellView} from '@habemus-papadum/aiui-viz';
import {JsonView} from '@habemus-papadum/aiui-viz/site/json-view';
import {CommandPalette} from '../../../055-orchestrator-mock-lab/shared/CommandPalette';
import {graph} from '../model/graph';
import * as state from '../model/store';
import type {Projection, Provider} from '../model/types';
import {number, Transcript, UsageStrip} from './Transcript';
import {StudyPanels} from './StudyPanels';

const empty: Projection = {items: [], usage: {basis: 'No reported measurements.'}, notes: []};
const phaseLabel = {idle: 'Not launched', launching: 'Launching', ready: 'Ready for a turn', working: 'Turn active', disconnected: 'Client disconnected', ending: 'Ending runtime', ended: 'Runtime ended', error: 'Operation failed'};
function quietly(result: unknown) { void Promise.resolve(result).catch(() => {}); }
/** JsonView intentionally snapshots a tree; replace it when its native record changes. */
function NativeRecord(props: {value: unknown}) {
  return <Show when={props.value} keyed fallback={<JsonView value={null}/>}>
    {value => <JsonView value={value}/>}
  </Show>;
}

function Comparison() {
  const live = () => graph().live.latest() ?? empty;
  const history = () => graph().history.latest() ?? empty;
  const counts = (projection: Projection) => [
    projection.items.filter(item => item.role === 'user').length,
    projection.items.filter(item => item.role === 'assistant' && item.kind === 'message').length,
    projection.items.filter(item => item.kind === 'tool').length,
    projection.items.filter(item => item.kind === 'reasoning').length,
    projection.items.filter(item => item.kind === 'unknown').length,
  ];
  return <div class="live-comparison">
    <Show when={state.session.get().history} fallback={<div class="live-empty"><span>⇄</span><p>Read saved history after a turn to compare two views of this conversation.</p></div>}>
      <section class="live-compare-summary"><div><h2>Same conversation, different evidence</h2><p>Live messages contain progress and control events. Saved history may combine or omit them. Counts describe these projections, not equivalence.</p></div>
        <table><thead><tr><th>Displayed items</th><th>Live</th><th>Saved</th></tr></thead><tbody>
          <For each={['User', 'Agent prose', 'Tools', 'Reasoning', 'Unknown']} >{(label, index) => <tr><th>{label}</th><td>{counts(live())[index()]}</td><td>{counts(history())[index()]}</td></tr>}</For>
        </tbody></table>
        <details><summary>Comparison details</summary><NativeRecord value={graph().comparison.latest()}/></details>
      </section>
      <div class="live-compare-columns"><section><header><h2>Live stream</h2><span>{state.session.get().records.length} received/sent records</span></header><UsageStrip usage={live().usage}/><Transcript projection={live()} expanded={state.detail.get() === 'expanded'}/></section>
        <section><header><h2>Saved native history</h2><span>{state.session.get().history?.source?.capturedAt || state.session.get().history?.source?.method || 'Native read'}</span></header><UsageStrip usage={history().usage}/><Transcript projection={history()} expanded={state.detail.get() === 'expanded'}/></section></div>
    </Show>
  </div>;
}

export function App() {
  const current = () => state.session.get();
  const live = () => graph().live.latest() ?? empty;
  const saved = () => graph().history.latest() ?? empty;
  const shown = () => graph().displayed.latest() ?? empty;
  const setup = () => graph().setup.latest();
  const hasRuntime = () => Boolean(current().run && current().phase !== 'ended');
  const selectedProvider = () => hasRuntime() ? current().run!.provider : state.provider.get();
  const selectedConfiguration = () => graph().configuration.latest()?.providers.find(item => item.provider === selectedProvider());
  const targetProfile = () => hasRuntime() ? current().run!.profileDirectory : setup()?.profileDirectory;
  const targetModel = () => hasRuntime() ? current().run!.model : setup()?.model;
  const canLaunch = () => !hasRuntime() && current().phase !== 'launching' && Boolean(setup()?.authAvailable);
  const canRead = () => Boolean(current().run) && !['launching', 'working', 'ending'].includes(current().phase) && !current().historyLoading;
  const canEnd = () => hasRuntime() && !['launching', 'ending'].includes(current().phase);
  const canDisconnect = () => hasRuntime() && ['ready', 'working', 'error'].includes(current().phase) && !state.managementBusy.get();
  const canSend = () => current().phase === 'ready' && Boolean(state.draft.get().trim());
  const error = () => state.actionError.get() || current().error;
  const readingWorkbench = () => isPending(() => graph().catalogue())
    || isPending(() => graph().libraryChoice()) || isPending(() => graph().runs());
  let scroller: HTMLElement | undefined;
  let prompt: HTMLTextAreaElement | undefined;
  bridgeEffect(() => ({count: current().records.length, follow: state.follow.get(), view: state.view.get()}), value => {
    if (value.follow && value.view === 'live') queueMicrotask(() => { if (scroller?.isConnected) scroller.scrollTop = scroller.scrollHeight; });
  }, {scope: state.appScope, name: 'follow-conversation'});

  return <main class="live-study">
    <header class="live-header"><a href="/">HP / lab</a><strong>Live workspace</strong><nav><a href="/history/">History</a><a href="/connections/">Connections</a><a href="/profiles/">Profiles</a></nav><span class="live-real">● real agents</span><button class="live-study-button" aria-expanded={state.notes.get() ? 'true' : 'false'} onClick={() => state.notes.set(!state.notes.get())}>Study ↗</button></header>

    <section class="live-launch-row" aria-label="Launch a session">
      <div class="live-provider-switch"><For each={['codex', 'claude'] as Provider[]}>{provider => <button disabled={hasRuntime() || current().phase === 'launching'} class={selectedProvider() === provider ? 'selected' : ''} onClick={() => state.provider.set(provider)} data-control={state.provider.name}><span class={`live-provider-icon ${provider}`}>{provider === 'codex' ? '◇' : '✳'}</span>{provider === 'codex' ? 'Codex' : 'Claude'}</button>}</For></div>
      <label class="live-cwd"><span>Working directory</span><input aria-label="Working directory" data-control={state.cwd.name} value={state.cwd.get()} placeholder={graph().configuration.latest()?.defaultCwd ?? 'Loading lab directory…'} disabled={hasRuntime() || current().phase === 'launching'} onInput={event => state.cwd.set(event.currentTarget.value)}/></label>
      <span class="live-model" title={hasRuntime() ? 'Requested model for this session' : 'Model for the next launch'}>{targetModel() ?? '…'}</span>
      <Show when={!hasRuntime()} fallback={<button disabled={!canEnd()} onClick={() => quietly(state.end.run())} title="Stop the runtime owned by this study; keep saved history">■ End runtime</button>}>
        <button class="live-primary" disabled={!canLaunch()} onClick={() => quietly(state.launch.run())}>{current().phase === 'launching' ? 'Launching…' : current().phase === 'ended' ? 'Launch another' : 'Launch session'}</button>
      </Show>
    </section>

    <CellView of={graph().configuration} label="Reading lab configuration">{configuration => <div class="live-target">
      <span title={targetProfile()}>{hasRuntime() ? 'Profile' : 'Next launch profile'} <code>{targetProfile() ?? 'Not prepared'}</code></span>
      <span title={selectedConfiguration()?.authDescription}>{selectedConfiguration()?.authAvailable ? 'Credential reference present · model access is separate' : selectedConfiguration()?.authDescription ?? 'Authentication unavailable'}</span>
      <Show when={!state.cwd.get()}><span title={configuration().defaultCwd}>Default directory <code>{configuration().defaultCwd}</code></span></Show>
    </div>}</CellView>

    <Show when={state.notes.get()}><aside class="live-study-notes"><button aria-label="Close study notes" onClick={() => state.notes.set(false)}>×</button><h2>Owned live sessions</h2><p>Launch into one of two isolated lab profiles, then send real prompts. This page does not discover or attach to outside processes.</p><p>Saved sessions reads native history independently of the live conversation. Resume latest retains conversation identity; fork creates a new conversation at a supported native boundary, in the recorded profile and directory. Neither restores files.</p><p>Closing a Claude SDK connection ends its worker. Codex has a separate server lifetime; use <b>End runtime</b> to stop this study's owned server. Interruption does not roll back files or tool effects. Owned runtimes shows current observations separately from previous owner records.</p><p>Only <b>Send new turn</b> submits your draft. Inspecting history or opening a continuation preserves it. Steering, queue policy and broader recovery remain separate work.</p><a href="/067-live-session-workspace/README.md">Operation map, evidence and limits ↗</a><button onClick={() => state.refreshConfiguration.run()}>Refresh configuration</button></aside></Show>

    <Show when={error()}><div class="live-notice live-error" role="alert">{error()}</div></Show>
    <Loading fallback={<div class="live-workbench-pending" role="status">◌ Reading workbench state…</div>}><Show when={readingWorkbench()}><div class="live-workbench-pending" role="status">◌ Reading native history or runtime observations…</div></Show></Loading>
    <section class="live-viewbar"><div class="live-view-tabs" role="tablist" aria-label="Conversation source"><For each={['live', 'history', 'compare']}>{view => <button role="tab" aria-selected={state.view.get() === view ? 'true' : 'false'} class={state.view.get() === view ? 'selected' : ''} onClick={() => state.view.set(view)}>{view === 'live' ? 'Live' : view === 'history' ? 'Saved history' : 'Compare'}<small>{view === 'live' ? live().items.length : view === 'history' ? saved().items.length : '⇄'}</small></button>}</For></div>
      <button disabled={!canRead()} onClick={() => quietly(state.readHistory.run())}>{current().historyLoading ? 'Reading…' : '↻ Read saved history'}</button><Show when={current().run}><span class="live-run-badge" title={`Displayed conversation: ${current().run?.provider} · ${current().run?.threadId ?? current().run?.workerId ?? current().run?.id}`}>{current().run?.provider === 'codex' ? '◇ Codex' : '✳ Claude'} · {(current().run?.threadId ?? current().run?.workerId ?? current().run?.id)?.slice(0, 8)}</span></Show><span class="live-spacer"/>
      <button aria-pressed={state.detail.get() === 'expanded' ? 'true' : 'false'} onClick={() => state.detail.set(state.detail.get() === 'expanded' ? 'compact' : 'expanded')}>{state.detail.get() === 'expanded' ? '− Fold tools' : '+ Expand tools'}</button>
      <button class={state.inspector.get() ? 'selected' : ''} onClick={() => state.inspector.set(!state.inspector.get())} title="Inspect native records and source provenance">⌗ Source</button>
      <button class={state.panel.get() === 'history' ? 'selected' : ''} onClick={() => state.panel.get() === 'history' ? state.panel.set('none') : state.refreshHistory.run({provider: current().run?.provider ?? state.provider.get()})}>▤ Saved sessions</button>
      <button class={state.panel.get() === 'runs' ? 'selected' : ''} onClick={() => state.panel.get() === 'runs' ? state.panel.set('none') : state.refreshRuns.run()}>◫ Runtimes</button>
    </section>
    <Show when={current().run?.continuation}><div class="live-context-stamp"><b>{current().run?.continuation?.kind === 'fork' ? 'Forked context' : 'Resumed context'}</b><span title={current().run?.continuation?.sourceSessionId}>from {current().run?.continuation?.sourceSessionId.slice(0, 12)}</span><Show when={current().run?.continuation?.pointId}><span title={current().run?.continuation?.pointId}>through {current().run?.continuation?.pointKind} {current().run?.continuation?.pointId?.slice(0, 12)}</span></Show><span>Saved context precedes new live output · no filesystem restore</span></div></Show>
    <Show when={state.view.get() !== 'live' && current().history}><div class="live-snapshot-stamp">Saved snapshot · {current().history?.source?.capturedAt ?? 'native history read'}<span>Read again to include later turns.</span></div></Show>
    <Show when={state.view.get() !== 'compare'}><UsageStrip usage={shown().usage} label={state.view.get() === 'live' ? 'Live' : 'Saved'}/></Show>

    <div class={`live-work-area ${state.inspector.get() ? 'with-inspector' : ''} ${state.panel.get() !== 'none' ? 'with-study-panel' : ''}`}>
      <section class="live-scroll" ref={element => { scroller = element; }} aria-label="Conversation" onWheel={() => state.follow.set(false)} onTouchMove={() => state.follow.set(false)}>
        <Show when={state.view.get() === 'compare'} fallback={<Transcript projection={shown()} expanded={state.detail.get() === 'expanded'} empty={state.view.get() === 'history' ? 'Read saved history after a turn. Reading it does not resume or launch work.' : current().phase === 'ended' ? 'Runtime ended. Browse saved sessions or launch another conversation.' : current().phase === 'disconnected' ? 'Client disconnected. Inspect saved history or end the owned runtime.' : current().run ? 'No conversation messages observed yet.' : 'Choose a provider and working directory, then launch a session.'}/> }><Comparison/></Show>
      </section>
      <Show when={state.panel.get() !== 'none'}><StudyPanels/></Show>
      <Show when={state.inspector.get()}><aside class="live-inspector"><header><h2>Native source</h2><button aria-label="Close source inspector" onClick={() => state.inspector.set(false)}>×</button></header>
        <Show when={graph().selectedItem.latest()} fallback={<><p>Choose ⌗ on a message or operation to inspect its native record.</p><dl><dt>Run</dt><dd>{current().run?.id ?? 'Not launched'}</dd><dt>Conversation</dt><dd>{current().run?.threadId ?? current().run?.workerId ?? 'Not assigned'}</dd><dt>Live records</dt><dd>{current().records.length}</dd></dl><Show when={current().history}><details open><summary>History source</summary><NativeRecord value={current().history?.source}/></details></Show></>}>
          {item => <><strong>{item().title}</strong><p>{item().source} · {item().kind} · {item().nativeId ?? 'No native ID supplied'}</p><NativeRecord value={item().raw}/></>}
        </Show>
        <details><summary>Latest live record</summary><NativeRecord value={current().records.at(-1) ?? {available: false}}/></details>
      </aside></Show>
    </div>

    <form class="live-composer" onSubmit={event => { event.preventDefault(); if (canSend()) quietly(state.send.run()); }}>
      <div class="live-composer-intent"><strong>New turn</strong><span>{current().phase === 'working' ? 'A turn is active. Your draft stays here until it finishes.' : current().phase === 'disconnected' ? 'Client disconnected. The draft stays here; inspect history or end the owned runtime.' : current().phase === 'ended' ? 'Runtime ended. Launch or continue a session to send your draft.' : current().run ? 'Send to this session when ready.' : 'Launch or continue a session to send a prompt.'}</span><button type="button" disabled={!canDisconnect()} onClick={() => quietly(state.disconnect.run())} title={current().run?.provider === 'claude' ? 'Close this SDK client; its Claude worker ends. No draft is replayed.' : 'Close this client connection; the Codex server remains owned by the lab.'}>⏏ Disconnect client</button><button type="button" class={state.follow.get() ? 'selected' : ''} onClick={() => state.follow.set(!state.follow.get())} title="Follow new live output">↓ {state.follow.get() ? 'Following' : 'Follow'}</button></div>
      <div class="live-composer-input"><textarea ref={element => { prompt = element; }} aria-label="Prompt" data-control={state.draft.name} value={state.draft.get()} onInput={event => state.draft.set(event.currentTarget.value)} placeholder="Ask a question or give this session a task…" rows={2} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSend()) { event.preventDefault(); quietly(state.send.run()); } }}/><div class="live-send-actions"><button type="button" disabled={current().phase !== 'working'} onClick={() => quietly(state.interrupt.run())}>↯ Interrupt</button><button type="submit" class="live-primary" disabled={!canSend()}>Send new turn ↑</button></div></div>
    </form>
    <footer class="live-footer"><span class={`live-phase ${current().phase}`}><i/>{phaseLabel[current().phase]}</span><span class="live-footer-notice" title={current().notice}>{current().notice || 'Opening this page does not start an agent.'}</span><span>⌘/Ctrl Enter sends · Space commands</span></footer>
    <CommandPalette scope="live-session-workspace" commands={[
      {id: 'launch', group: 'Session', label: 'Launch selected session', key: 'l', icon: '▷', run: () => state.launch.run(), enabled: canLaunch},
      {id: 'end', group: 'Session', label: 'End owned runtime', key: 'e', icon: '■', run: () => state.end.run(), enabled: canEnd},
      {id: 'disconnect', group: 'Session', label: 'Disconnect this client', key: 'd', icon: '⏏', run: () => state.disconnect.run(), enabled: canDisconnect},
      {id: 'prompt', group: 'Conversation', label: 'Focus prompt', key: 'p', icon: '↑', run: () => prompt?.focus()},
      {id: 'interrupt', group: 'Conversation', label: 'Interrupt active turn', key: 'i', icon: '↯', run: () => state.interrupt.run(), enabled: () => current().phase === 'working'},
      {id: 'history', group: 'Inspect', label: 'Read saved history', key: 'h', icon: '↻', run: () => state.readHistory.run(), enabled: canRead},
      {id: 'browse', group: 'Inspect', label: 'Browse native saved sessions', key: 'b', icon: '▤', run: () => state.refreshHistory.run({provider: current().run?.provider ?? state.provider.get()})},
      {id: 'runs', group: 'Inspect', label: 'Owned runtime observations', key: 'r', icon: '◫', run: () => state.refreshRuns.run()},
      {id: 'live', group: 'Inspect', label: 'Live transcript', key: 'v', icon: '●', run: () => state.view.set('live')},
      {id: 'compare', group: 'Inspect', label: 'Compare live and saved', key: 'c', icon: '⇄', run: () => state.view.set('compare')},
      {id: 'source', group: 'Inspect', label: 'Toggle source inspector', key: 's', icon: '⌗', run: () => state.inspector.set(!state.inspector.get())},
    ]}/>
  </main>;
}

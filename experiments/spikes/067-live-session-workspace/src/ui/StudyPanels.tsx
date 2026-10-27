import {For, Show} from 'solid-js';
import {CellView} from '@habemus-papadum/aiui-viz';
import {JsonView} from '@habemus-papadum/aiui-viz/site/json-view';
import {graph} from '../model/graph';
import * as state from '../model/store';
import type {HistoryChoice, HistoryRef, Provider, Run} from '../model/types';
import {Transcript} from './Transcript';

const quietly = (value: unknown) => {void Promise.resolve(value).catch(() => {});};
const referenceKey = (ref: HistoryRef | null) => ref ? `${ref.provider}:${ref.cwd}:${ref.sessionId}` : '';
function time(value: unknown): string {
  if (value == null) return 'Not recorded';
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value as string | number);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
function RecordView(props: {value: unknown}) {
  return <Show when={props.value} keyed fallback={<JsonView value={null}/>}>
    {value => <JsonView value={value}/>}
  </Show>;
}
function HistorySelection(props: {choice: HistoryChoice}) {
  const current = () => referenceKey(props.choice.reference) === referenceKey(state.historyReference.get());
  const hasRuntime = () => Boolean(state.session.get().run && state.session.get().phase !== 'ended');
  const canContinue = () => current() && !hasRuntime() && !state.managementBusy.get()
    && state.session.get().phase !== 'launching'
    && (state.continuationKind.get() === 'resume' || props.choice.branchPoints.some(point => point.id === state.branchPoint.get()));
  return <section class="live-history-selection">
    <header><b title={props.choice.reference.title}>{props.choice.reference.title || props.choice.reference.sessionId}</b><span class="live-source-label">Native history · inspection</span></header>
    <dl class="live-reference-facts"><dt>Conversation</dt><dd title={props.choice.reference.sessionId}>{props.choice.reference.sessionId}</dd><dt>Profile</dt><dd title={props.choice.reference.profileDirectory}>{props.choice.reference.profileDirectory}</dd><dt>Continue in</dt><dd title={props.choice.reference.cwd}>{props.choice.reference.cwd}</dd></dl>
    <div class="live-continuation-form">
      <div class="live-choice-buttons"><button disabled={state.managementBusy.get()} class={state.continuationKind.get() === 'resume' ? 'selected' : ''} onClick={() => state.continuationKind.set('resume')}>Resume latest</button><button disabled={state.managementBusy.get()} class={state.continuationKind.get() === 'fork' ? 'selected' : ''} onClick={() => state.continuationKind.set('fork')}>Fork from a point</button></div>
      <Show when={state.continuationKind.get() === 'fork'}>
        <label>Native boundary<select aria-label="Fork boundary" data-control={state.branchPoint.name} value={state.branchPoint.get()} disabled={state.managementBusy.get()} onChange={event => state.branchPoint.set(event.currentTarget.value)}><option value="">Choose a boundary…</option><For each={props.choice.branchPoints}>{point => <option value={point.id}>{point.kind} · {point.label}</option>}</For></select></label>
        <Show when={!props.choice.branchPoints.length}><p class="live-panel-note">This history read supplied no supported fork boundaries.</p></Show>
      </Show>
      <p class="live-panel-note">{state.continuationKind.get() === 'resume' ? 'Opens the same conversation at its latest saved context.' : 'Creates a new conversation through the selected native boundary; the source remains.'} Files and tool effects are not restored.</p>
      <Show when={hasRuntime()} fallback={<p class="live-panel-note">The draft below stays unsent. Opening a session is a separate action from Send.</p>}><p class="live-panel-note live-panel-attention">End this page’s current runtime before opening another conversation.</p></Show>
      <button class="live-primary" disabled={!canContinue()} onClick={() => quietly(state.continueHistory.run())}>{state.managementBusy.get() ? 'Opening…' : state.continuationKind.get() === 'resume' ? 'Open resumed session' : 'Open forked session'}</button>
    </div>
    <details class="live-native-history-source"><summary>Source and native fields</summary><RecordView value={{reference: props.choice.reference, source: props.choice.document.source}}/></details>
    <CellView of={graph().libraryProjection} keepLatest={false} label="Projecting native history">{projection => <Transcript projection={projection()} expanded={state.detail.get() === 'expanded'} empty="No visible items were returned by this native history read."/>}</CellView>
  </section>;
}

function SavedSessions() {
  const changeProvider = (provider: Provider) => {
    state.historyProvider.set(provider); state.historyReference.set(null); state.branchPoint.set(''); state.historySearch.set('');
  };
  return <>
    <div class="live-history-tools"><select aria-label="Saved history provider" data-control={state.historyProvider.name} value={state.historyProvider.get()} disabled={state.managementBusy.get()} onChange={event => changeProvider(event.currentTarget.value as Provider)}><option value="codex">Codex history</option><option value="claude">Claude history</option></select><button disabled={state.managementBusy.get()} onClick={() => state.refreshHistory.run()}>↻ Refresh</button></div>
    <input class="live-history-search" aria-label="Find saved session" data-control={state.historySearch.name} value={state.historySearch.get()} onInput={event => state.historySearch.set(event.currentTarget.value)} placeholder="Title, conversation, working directory…"/>
    <CellView of={graph().catalogueRows} keepLatest={false} label="Reading native catalogue">{rows => <div class="live-history-list">
      <For each={rows()}>{row => <button class={referenceKey(state.historyReference.get()) === referenceKey(row) ? 'selected' : ''} disabled={state.managementBusy.get()} onClick={() => quietly(state.selectHistory.run({reference: row}))} title={`${row.sessionId}\n${row.cwd}`}><b>{row.title || row.sessionId.slice(0, 12)}</b><span>{row.sessionId.slice(0, 8)} · {time(row.updatedAt)}</span><small>{row.cwd}</small></button>}</For>
      <Show when={!rows().length}><p class="live-panel-note">No matching saved conversations in this native catalogue.</p></Show>
    </div>}</CellView>
    <p class="live-panel-scope">{graph().catalogue.latest()?.scope ?? 'Native lab-profile catalogue'}</p>
    <CellView of={graph().libraryChoice} keepLatest={false} label="Reading selected native history">{choice => <Show when={choice()} fallback={<div class="live-panel-empty">Select a conversation to inspect it. This does not resume an agent or send your draft.</div>}>
      {value => <HistorySelection choice={value()}/>}
    </Show>}</CellView>
  </>;
}

const runtimeState = (run: Run) => run.runtime?.state ?? 'Not observed';
function OwnedRuntimes() {
  const rows = () => graph().runs.latest()?.rows ?? [];
  const owned = () => rows().filter(run => run.owned === true && run.state !== 'ended');
  return <>
    <div class="live-owned-tools"><button onClick={() => state.refreshRuns.run()}>↻ Read status</button><span>{owned().length} owned</span><button disabled={!owned().length || state.managementBusy.get()} onClick={() => quietly(state.endAllRuns.run())}>End all owned ({owned().length})</button></div>
    <p class="live-panel-note">Record state and native runtime observation are separate. Connected does not mean a turn is active. End targets only this lab’s owned runs.</p>
    <CellView of={graph().runs} keepLatest={false} label="Reading runtime observations">{observation => <>
      <p class="live-panel-scope">Read {time(observation().readAt)}</p>
      <div class="live-owned-list"><For each={observation().rows}>{run => <article class="live-owned-run">
        <header><b><span class={`live-provider-icon ${run.provider}`}>{run.provider === 'codex' ? '◇' : '✳'}</span> {run.provider === 'codex' ? 'Codex' : 'Claude'} · {run.id.slice(0, 8)}</b><small>{run.owned ? 'Owned here' : 'Previous owner record'}</small></header>
        <div class="live-run-states"><span>Record <b>{run.state ?? 'unknown'}</b></span><span>Runtime <b>{runtimeState(run)}</b></span><Show when={run.runtime?.pid}><span>PID {run.runtime.pid}</span></Show></div>
        <p class="live-run-location" title={run.cwd}>{run.cwd}</p><small title={run.threadId}>{run.threadId ?? 'No conversation identity yet'}</small>
        <footer><small>{run.runtime?.observedAt ? time(run.runtime.observedAt) : 'No current observation'}</small><button disabled={run.owned !== true || run.state === 'ended' || state.managementBusy.get()} onClick={() => quietly(state.endRun.run({id: run.id}))}>{state.session.get().run?.id === run.id ? 'End this runtime' : 'End runtime'}</button></footer>
        <details><summary>Ownership and native observation</summary><RecordView value={run}/></details>
      </article>}</For></div>
      <Show when={!observation().rows.length}><div class="live-panel-empty">No run records are available from this lab owner.</div></Show>
    </>}</CellView>
    <Show when={state.managementReceipt.get()}><details class="live-management-receipt" open><summary>Last explicit management action</summary><RecordView value={state.managementReceipt.get()}/></details></Show>
  </>;
}

export function StudyPanels() {
  return <aside class="live-study-panel" aria-label={state.panel.get() === 'history' ? 'Saved sessions' : 'Owned runtimes'}>
    <header class="live-panel-header"><div><button class={state.panel.get() === 'history' ? 'selected' : ''} onClick={() => state.panel.set('history')}>Saved sessions</button><button class={state.panel.get() === 'runs' ? 'selected' : ''} onClick={() => state.panel.set('runs')}>Owned runtimes</button></div><button aria-label="Close workbench panel" onClick={() => state.panel.set('none')}>×</button></header>
    <div class="live-panel-scroll"><Show when={state.panel.get() === 'history'} fallback={<OwnedRuntimes/>}><SavedSessions/></Show></div>
  </aside>;
}

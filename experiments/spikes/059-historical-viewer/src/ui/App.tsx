import {createEffect, For, Show} from 'solid-js';
import {CellView, ControlSelect} from '@habemus-papadum/aiui-viz';
import {JsonView} from '@habemus-papadum/aiui-viz/site/json-view';
import {TextView} from '@habemus-papadum/aiui-viz/site/markdown';
import {CommandPalette, type Command} from '../../../055-orchestrator-mock-lab/shared/CommandPalette';
import {graph, stepItem} from '../model/graph';
import * as state from '../model/store';
import {formatCount, object, type Block, type HistoryEntry, type HistoryItem, type HistoryProjection} from '../model/native';
import {Code, RichText} from './RichText';

function NativeLink(props: {sessionId: string; entries: HistoryEntry[]; label?: string}) {
  const target = () => props.entries.find(entry => entry.sessionId === props.sessionId);
  return <Show when={target()} fallback={<span class="history-unavailable">{props.label ?? 'Related session'} {props.sessionId} · outside this capture</span>}>
    <button class="history-related" onClick={() => state.openHistory.run({key: target()!.key})}>{props.label ?? 'Read related session'} ↗ <code>{props.sessionId.slice(0, 12)}</code></button>
  </Show>;
}

function BlockView(props: {block: Block}) {
  const block = props.block;
  switch (block.kind) {
    case 'markdown': return <RichText text={block.text ?? ''}/>;
    case 'thinking': return <details class="history-thinking"><summary>Thinking · recorded text</summary><RichText text={block.text ?? ''}/></details>;
    case 'code': return <Code text={block.text ?? ''} language={block.language} label={block.label}/>;
    case 'tool': return <details class="history-tool" open><summary>{block.label || 'Tool call'} <span>arguments</span></summary><Show when={block.text} fallback={<JsonView value={block.raw} depth={1}/>}><Code text={block.text ?? ''} language="json"/></Show></details>;
    case 'result': return <details class="history-result" open><summary>{block.label || 'Tool result'}</summary><TextView text={block.text ?? ''} markdown={false}/></details>;
    case 'image': return <figure class="history-image"><Show when={block.url} fallback={<p>Image reference retained; no exported image bytes available.</p>}><img src={block.url} alt={block.label || 'Recorded image'} loading="lazy"/></Show><figcaption>{block.label}</figcaption><details><summary>Image source record</summary><JsonView value={block.raw} depth={1}/></details></figure>;
    default: return <div class="history-unknown"><span class="history-eyebrow">{block.label || 'Unknown block'} · preserved</span><JsonView value={block.raw} depth={1}/></div>;
  }
}

function Item(props: {item: HistoryItem; entries: HistoryEntry[]; ordinal: number}) {
  const item = props.item;
  return <article class="history-item" data-history-item={item.id} data-role={item.role} data-selected={state.focus.get().id === item.id} tabindex={-1}>
    <header class="history-item-header"><button class="history-item-number" title="Focus this item" onClick={() => state.jump.run({id: item.id})}>{props.ordinal + 1}</button>
      <strong>{item.label}</strong><Show when={item.model}><span>{item.model}</span></Show><Show when={item.timestamp}><time>{item.timestamp}</time></Show>
      <button class="history-item-raw" onClick={() => {state.jump.run({id: item.id}); state.inspector.set('raw');}}>Raw record ↗</button>
    </header>
    <div class="history-item-content"><For each={item.blocks}>{block => <BlockView block={block}/>}</For></div>
    <footer class="history-item-footer"><code title={item.path}>{item.nativeId ?? 'native ID unavailable'}</code>
      <Show when={item.requestId}><span title="Usage is deduplicated by native model response ID">response {item.requestId}</span></Show>
      <Show when={item.usage}><span>in {formatCount(item.usage?.input ?? null)} · cached {formatCount(item.usage?.cachedInput ?? null)} · out {formatCount(item.usage?.output ?? null)}</span></Show>
      <Show when={item.parentRequestId}><span>usage belongs to response {item.parentRequestId}</span></Show>
      <For each={item.childIds}>{id => <NativeLink sessionId={id} entries={props.entries} label="Read child"/>}</For>
    </footer>
  </article>;
}

function SourceCatalog() {
  return <aside class="history-catalog" aria-label="Captured sessions">
    <div class="history-panel-head"><strong>Captured sessions</strong><button title="Hide sources" onClick={() => state.toggleSources.run()}>×</button></div>
    <div class="history-source-controls"><ControlSelect of={state.provider} label="Provider"/>
      <input type="search" aria-label="Search captured sessions" placeholder="Title or session ID…" data-control={state.catalogQuery.name} value={state.catalogQuery.get()} onInput={e => state.catalogQuery.set(e.currentTarget.value)}/></div>
    <CellView of={graph().sources} label="Reading catalog">{entries => <div class="history-source-list">
      <For each={['codex', 'claude']}>{provider => <Show when={entries().some(entry => entry.provider === provider)}><section>
        <h2 class="history-provider-title">{provider} <span>{entries().filter(entry => entry.provider === provider).length}</span></h2>
        <For each={entries().filter(entry => entry.provider === provider)}>{entry => <button class="history-session" data-selected={(state.selectedKey.get() || graph().catalog.latest()?.sessions[0]?.key) === entry.key} onClick={() => state.openHistory.run({key: entry.key})}>
          <strong>{entry.title || 'Untitled native session'}</strong><small>{entry.sessionId}</small><span>{String(entry.source.kind)} · captured</span>
        </button>}</For>
      </section></Show>}</For>
      <Show when={graph().catalog.latest()?.loadError}><p class="history-warning" role="alert">{graph().catalog.latest()?.loadError}</p></Show>
      <Show when={!entries().length && !graph().catalog.latest()?.loadError}><p class="history-empty">No captured sessions match.</p></Show>
    </div>}</CellView>
    <div class="history-bench"><span class="history-eyebrow">Rendering exercise</span><button onClick={() => state.openHistory.run({key: '@specimen'})}>Open synthetic bench ↗</button><small>Math, diagrams and images. Separate from provider evidence.</small></div>
  </aside>;
}

function Provenance(props: {projection: HistoryProjection; entries: HistoryEntry[]}) {
  const d = props.projection.document;
  const coverage = () => object(d.source.coverage);
  const thread = object(object(d.payload).thread), info = object(object(d.payload).info);
  const nativeMetadata = d.provider === 'codex' ? {...thread, turns: '(inspect the complete raw payload)'} : info;
  const parent = typeof thread.parentThreadId === 'string' ? thread.parentThreadId : null;
  const fork = typeof thread.forkedFromId === 'string' ? thread.forkedFromId : null;
  return <div class="history-provenance"><span class="history-eyebrow">Exact source</span>
    <dl><dt>Native ID</dt><dd><code>{d.sessionId}</code></dd><dt>Method</dt><dd>{d.source.method}</dd><dt>Captured</dt><dd>{d.source.capturedAt}</dd><dt>Version</dt><dd>{String(d.source.version ?? 'not supplied')}</dd><dt>Host</dt><dd>{String(d.source.host ?? 'not supplied')}</dd><dt>Runtime</dt><dd>{String(coverage().runtime ?? 'Unknown; stored history only')}</dd></dl>
    <Show when={parent}><NativeLink sessionId={parent!} entries={props.entries} label="Read parent"/></Show>
    <Show when={fork}><NativeLink sessionId={fork!} entries={props.entries} label="Read fork origin"/></Show>
    <h3>Coverage</h3><p>{props.projection.items.length} readable items · {props.projection.unknownBlocks} unrecognized blocks retained</p>
    <Show when={coverage().usage}><p>{String(coverage().usage)}</p></Show>
    <Show when={Array.isArray(coverage().missing)}><ul><For each={coverage().missing as unknown[]}>{value => <li>{String(value)}</li>}</For></ul></Show>
    <Show when={Array.isArray(coverage().errors) && (coverage().errors as unknown[]).length}><div class="history-coverage-error"><strong>Native read gaps</strong><JsonView value={coverage().errors} depth={2}/></div></Show>
    <h3>Usage meaning</h3><p>{props.projection.ledger.explanation}</p><p>Cost and context occupancy: unknown. Counts cover captured request fields only.</p>
    <details><summary>Request ledger · {props.projection.ledger.requests.length} native responses</summary><JsonView value={props.projection.ledger.requests} depth={1}/></details>
    <details><summary>All source metadata</summary><JsonView value={d.source} depth={1}/></details>
    <details><summary>Native session metadata</summary><JsonView value={nativeMetadata} depth={1}/></details>
  </div>;
}

function Inspector(props: {projection: HistoryProjection; entries: HistoryEntry[]}) {
  const selected = () => props.projection.items.find(item => item.id === state.focus.get().id);
  return <aside class="history-inspector" aria-label="History inspector"><div class="history-panel-head"><ControlSelect of={state.inspector} label="Inspect"/><button title="Close inspector" onClick={() => state.inspector.set('closed')}>×</button></div>
    <Show when={state.inspector.get() === 'raw'} fallback={<Provenance projection={props.projection} entries={props.entries}/>}>
      <div class="history-raw"><span class="history-eyebrow">Unmodified native JSON</span>
        <Show when={selected()} keyed fallback={<p>Choose “Raw record” on an item to inspect its exact source.</p>}>{item => <div><h3>{item.label}</h3><code>{item.path}</code><JsonView value={item.raw} depth={2}/></div>}</Show>
        <details open={!selected()}><summary>Complete export envelope</summary><JsonView value={props.projection.document} depth={1}/></details>
      </div>
    </Show>
  </aside>;
}

function Conversation(props: {projection: HistoryProjection}) {
  const entries = () => graph().catalog.latest()?.sessions ?? [];
  const ledger = () => props.projection.ledger;
  const d = () => props.projection.document;
  return <>
    <main class="history-conversation"><header class="history-conversation-head">
      <div><span class="history-eyebrow">{d().provider === 'specimen' ? 'Synthetic rendering bench' : `${d().provider} · native capture`}</span><h1>{d().title}</h1></div>
      <button onClick={() => state.inspector.set(state.inspector.get() === 'provenance' ? 'closed' : 'provenance')}>Source & coverage</button>
    </header>
    <Show when={d().provider === 'specimen'}><p class="history-specimen-banner">Authored renderer exercise. Nothing in this session is provider evidence.</p></Show>
    <div class="history-metrics"><span><b>{props.projection.items.length}</b> items</span><span><b>{formatCount(ledger().input)}</b> input</span><span><b>{formatCount(ledger().cachedInput)}</b> cache read</span><span><b>{formatCount(ledger().output)}</b> output</span><span><b>unknown</b> cost</span><span><b>unknown</b> context</span></div>
    <div class="history-transcript-controls"><input type="search" aria-label="Search transcript" placeholder="Find text or native ID…" data-control={state.query.name} value={state.query.get()} onInput={event => state.query.set(event.currentTarget.value)}/><ControlSelect of={state.kind} label="Items"/>
      <button title="Previous visible item (k)" onClick={() => stepItem.run({direction: 'previous'})}>↑</button><button title="Next visible item (j)" onClick={() => stepItem.run({direction: 'next'})}>↓</button>
    </div>
    <CellView of={graph().visible} label="Projecting native records" keepLatest={false}>{rows => <>
      <div class="history-jump"><label>Jump <select aria-label="Jump to transcript item" value={state.focus.get().id} onChange={event => state.jump.run({id: event.currentTarget.value})}><option value="">Choose an item…</option><For each={rows()}>{item => <option value={item.id}>{props.projection.items.indexOf(item) + 1} · {item.label} · {item.nativeId?.slice(0, 16)}</option>}</For></select></label><small>{rows().length} of {props.projection.items.length} shown · metrics use full capture</small></div>
      <div class="history-transcript" aria-label="Read-only transcript"><For each={rows()}>{item => <Item item={item} entries={entries()} ordinal={props.projection.items.indexOf(item)}/>}</For><Show when={!rows().length}><p class="history-empty">No transcript items match. The full export remains in the raw inspector.</p></Show><For each={props.projection.warnings}>{warning => <p class="history-warning">{warning}</p>}</For></div>
    </>}</CellView>
    </main>
    <Show when={state.inspector.get() !== 'closed'}><Inspector projection={props.projection} entries={entries()}/></Show>
  </>;
}

/** Disposable render layer; reader choices live in the scoped durable store. */
export function App() {
  const commands: Command[] = [
    {id: 'next', group: 'Navigate', label: 'Next item', key: 'j', icon: '↓', run: () => stepItem.run({direction: 'next'})},
    {id: 'previous', group: 'Navigate', label: 'Previous item', key: 'k', icon: '↑', run: () => stepItem.run({direction: 'previous'})},
    {id: 'sources', group: 'Navigate', label: 'Sources', key: 's', icon: '☷', run: () => state.toggleSources.run()},
    {id: 'raw', group: 'Inspect', label: 'Raw inspector', key: 'r', icon: '{}', run: () => state.toggleRaw.run()},
    {id: 'provenance', group: 'Inspect', label: 'Source and coverage', key: 'p', icon: '◈', run: () => state.inspector.set('provenance')},
    {id: 'refresh', group: 'Inspect', label: 'Refresh local export', key: 'u', icon: '↻', description: 'Read the existing capture files again', run: () => state.refresh.run()},
  ];
  createEffect(() => state.focus.get(), current => {
    if (!current.id) return;
    const target = document.querySelector<HTMLElement>(`[data-history-item="${CSS.escape(current.id)}"]`);
    target?.scrollIntoView({block: 'start', behavior: 'instant'});
    target?.focus({preventScroll: true});
  });
  return <div class="history-app"><header class="history-topbar"><a href="/">hp <span>lab</span></a><strong>Native history</strong><span class="history-readonly">◉ read only</span><span class="history-top-explanation">Stored conversations · no live attachment</span>
    <button onClick={() => state.toggleSources.run()}>Sources</button><button onClick={() => state.refresh.run()}>↻ Refresh export</button>
  </header>
    <div class="history-body" data-sources={state.sourcesOpen.get()} data-inspector={state.inspector.get() !== 'closed'}>
      <Show when={state.sourcesOpen.get()}><SourceCatalog/></Show>
      <CellView of={graph().projection} label="Reading local history export" keepLatest={false}>{projection => <Show when={projection()} keyed fallback={<main class="history-empty"><h1>{graph().document.latest()?.loadError ? 'Capture unavailable' : 'No captured sessions'}</h1><Show when={graph().document.latest()?.loadError}><p role="alert">{graph().document.latest()?.loadError}</p><code>{graph().document.latest()?.requestedKey}</code></Show><p>Export native history with spike 058, then refresh this reader.</p><button onClick={() => state.openHistory.run({key: '@specimen'})}>Open synthetic renderer bench</button></main>}>{value => <Conversation projection={value}/>}</Show>}</CellView>
    </div><CommandPalette scope="native-history" commands={commands}/>
  </div>;
}

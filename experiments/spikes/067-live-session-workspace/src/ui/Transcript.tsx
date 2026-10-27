import {createMemo, For, Show} from 'solid-js';
import {TextView} from '@habemus-papadum/aiui-viz/site/markdown';
import {inspectItem} from '../model/store';
import type {DisplayItem, Projection, Usage} from '../model/types';
import {RichMessage} from './RichMessage';

export const number = (value?: number) => value == null ? '—' : new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1}).format(value);
const money = (value?: number) => value == null ? '—' : value === 0 ? '$0' : `$${value < .01 ? value.toFixed(6) : value.toFixed(3)}`;
const icon = (item: DisplayItem) => item.kind === 'tool' ? '⌘' : item.kind === 'reasoning' ? '◌' : item.kind === 'unknown' ? '?' : item.role === 'user' ? '↑' : item.role === 'assistant' ? '✦' : '·';

export function UsageStrip(props: {usage: Usage; label?: string}) {
  const inputLabel = () => props.usage.inputBasis === 'uncached' ? 'uncached input' : props.usage.inputBasis === 'includes-cache' ? 'input incl. cache' : 'input';
  return <div class="live-usage" title={props.usage.basis}>
    <Show when={props.label}><strong class="live-source-label">{props.label}</strong></Show>
    <span title={`${inputLabel()}: ${props.usage.input ?? 'not reported'}`}><b>{number(props.usage.input)}</b> {inputLabel()}</span>
    <span title={`Cache-read tokens: ${props.usage.cached ?? 'not reported'}`}><b>{number(props.usage.cached)}</b> cached</span>
    <Show when={props.usage.cacheCreated != null}><span><b>{number(props.usage.cacheCreated)}</b> cache created</span></Show>
    <span title={`Output tokens: ${props.usage.output ?? 'not reported'}`}><b>{number(props.usage.output)}</b> output</span>
    <span><b>{money(props.usage.costUsd)}</b> reported estimate</span>
    <span><b>{number(props.usage.context)}</b><Show when={props.usage.contextWindow != null}> / {number(props.usage.contextWindow)}</Show> context</span>
    <small>— = not reported</small>
  </div>;
}

export function TranscriptItem(props: {item: DisplayItem; expanded: boolean}) {
  const item = () => props.item;
  const work = () => item().kind !== 'message';
  const failed = () => /error|fail|declin/i.test(item().state ?? '');
  return <article class={`live-item live-role-${item().role} live-kind-${item().kind}`} data-native-id={item().nativeId} data-state={failed() ? 'error' : item().state}>
    <Show when={work()} fallback={<>
      <header class="live-item-heading"><span class="live-item-icon">{icon(item())}</span><b>{item().role === 'user' ? 'You' : item().role === 'assistant' ? 'Agent' : item().role}</b>
        <Show when={item().phase}><small>{item().phase}</small></Show><Show when={item().state}><small>{item().state}</small></Show>
        <button class="live-raw-button" title="Inspect the native source record" onClick={() => inspectItem.run({key: `${item().source}:${item().id}`})}>⌗</button></header>
      <div class="live-message"><RichMessage text={item().text}/></div>
    </>}>
      <details class="live-operation" open={props.expanded}>
        <summary><span class="live-item-icon">{icon(item())}</span><b>{item().title || item().kind}</b><span class="live-operation-excerpt">{item().text.replace(/\s+/g, ' ').slice(0, 140)}</span><small>{item().state}</small></summary>
        <div class="live-operation-body"><div class="live-operation-actions"><span>{item().kind} · {item().source}</span><button onClick={() => inspectItem.run({key: `${item().source}:${item().id}`})}>Native record ⌗</button></div><TextView text={item().text || 'No display text; inspect the native record.'} markdown={false}/></div>
      </details>
    </Show>
  </article>;
}

export function Transcript(props: {projection: Projection; expanded: boolean; empty?: string}) {
  const items = createMemo(() => new Map(props.projection.items.map(item => [`${item.source}:${item.id}`, item])));
  // Protocol records remain in the projection and comparison. Presentation puts
  // them behind one disclosure so initialization/status traffic does not dominate
  // the conversation. Native errors stay in the primary chronology.
  const protocol = (item: DisplayItem) => item.role === 'system' && item.kind === 'unknown'
    && !/error|fail|declin|denied/i.test(`${item.state ?? ''} ${item.title}`)
    && !item.raw?.error && !item.raw?.message?.error;
  const equalKeys = (a: string[], b: string[]) => a.length === b.length && a.every((key, index) => key === b[index]);
  const keys = createMemo(() => props.projection.items.filter(item => !protocol(item)).map(item => `${item.source}:${item.id}`), {equals: equalKeys});
  const protocolKeys = createMemo(() => props.projection.items.filter(protocol).map(item => `${item.source}:${item.id}`), {equals: equalKeys});
  return <div class="live-transcript">
    <For each={keys()}>{key => <TranscriptItem item={items().get(key)!} expanded={props.expanded}/>}</For>
    <Show when={!keys().length}><div class="live-empty"><span>◌</span><p>{props.empty ?? 'No conversation items yet.'}</p></div></Show>
    <Show when={protocolKeys().length}><details class="live-protocol-records"><summary>Protocol / unrecognized records <b>{protocolKeys().length}</b></summary><p>Retained native records, grouped here for reading. Errors stay in the conversation.</p><For each={protocolKeys()}>{key => <TranscriptItem item={items().get(key)!} expanded={props.expanded}/>}</For></details></Show>
    <Show when={props.projection.notes.length}><details class="live-coverage"><summary>Source coverage · {props.projection.notes.length} notes</summary><ul><For each={props.projection.notes}>{note => <li>{note}</li>}</For></ul></details></Show>
  </div>;
}

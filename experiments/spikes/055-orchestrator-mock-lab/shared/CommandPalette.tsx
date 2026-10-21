import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { installKeys, isTypingTarget } from '@habemus-papadum/aiui-viz/keys';
import { commandGroups, commandLayers, commandMachine, type Command } from './keyboard';
import './command-palette.css';

export type { Command } from './keyboard';

/** Shared disposable command map. One key layer and one modal-state writer. */
export function CommandPalette(props: { scope: string; commands: readonly Command[] }) {
  const commands = props.commands;
  const groups = commandGroups(commands);
  const [error, setError] = createSignal('');
  const machine = commandMachine(commands, id => {
    const command = commands.find(c => c.id === id)!;
    try { Promise.resolve(command.run()).catch(e => setError(String(e))); }
    catch (e) { setError(String(e)); }
  });
  const [mode, setMode] = createSignal('closed');
  let dialog: HTMLElement | undefined;
  let previousFocus: HTMLElement | null = null;
  let wasOpen = false;
  const unsubscribe = machine.subscribe(state => setMode(String(state.palette)));
  createEffect(mode, current => {
    const open = current !== 'closed';
    if (open && !wasOpen) { previousFocus = document.activeElement as HTMLElement | null; queueMicrotask(() => dialog?.focus()); }
    if (!open && wasOpen && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    wasOpen = open;
  });
  const refresh = () => machine.setContext({ enabled: Object.fromEntries(commands.map(c => [c.id, c.enabled?.() ?? true])) });
  createEffect(() => Object.fromEntries(commands.map(c => [c.id, c.enabled?.() ?? true])), enabled => machine.setContext({ enabled }));
  const dispatch = (command: string) => { refresh(); machine.dispatch(command); };
  const uninstall = installKeys({ stack: commandLayers(commands),
    getState: () => { refresh(); return { palette: String(machine.state().palette), enabled: machine.context().enabled }; },
    dispatch,
    isTyping: event => {
      const target = event.composedPath()[0] as HTMLElement | null;
      return event.isComposing || event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event)
        || !!target?.closest?.('select')
        || (!!target?.closest?.('[data-aiui-chrome]') && !target?.closest?.('[data-command-palette]'))
        || (!!target?.closest?.('[aria-modal="true"]') && !target?.closest?.('[data-command-palette]'));
    },
  });
  const blur = () => machine.dispatch('blur');
  window.addEventListener('blur', blur);
  onCleanup(() => { uninstall(); unsubscribe(); window.removeEventListener('blur', blur); });
  return <div class="command-layer" data-command-palette data-aiui-chrome>
    <button class="command-launcher" title="Open keyboard commands (Space)" onClick={() => dispatch('open')}><kbd>Space</kbd> commands</button>
    <Show when={mode() !== 'closed'}>
      <div class="command-backdrop" onClick={() => dispatch('close')} />
      <section class="command-map" ref={element => { dialog = element; }} tabindex={-1} role="dialog" aria-label="Keyboard command map" aria-modal="true">
        <header><div><span class="command-eyebrow">{props.scope.replace('orchestrator-', '')} · keyboard</span>
          <h2>{mode() === 'root' ? 'Choose your next move' : mode()}</h2></div>
          <button onClick={() => dispatch('back')} title="Back or close (Escape)"><kbd>Esc</kbd> {mode() === 'root' ? 'close' : 'back'}</button></header>
        <div class="command-groups">
          <For each={groups.filter(g => mode() === 'root' || mode() === g.name)}>{group => <section class="command-group">
            <button class="command-group-name" onClick={() => dispatch(`group:${group.name}`)}><kbd>{group.key}</kbd>{group.name}</button>
            <For each={group.commands}>{command => <button class="command-item" disabled={command.enabled?.() === false}
              title={command.description ?? command.label} onClick={() => dispatch(`action:${command.id}`)}>
              <span class="command-icon">{command.icon ?? '◇'}</span><span><strong>{command.label}</strong><small>{command.description}</small></span><kbd>{command.key}</kbd>
            </button>}</For>
          </section>}</For>
        </div>
        <footer>Press a group key to narrow this map. Single-key shortcuts also work outside text fields.<Show when={error()}><p class="command-error">{error()}</p></Show></footer>
      </section>
    </Show>
  </div>;
}

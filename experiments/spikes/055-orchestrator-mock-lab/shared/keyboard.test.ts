import { describe, expect, it } from 'vitest';
import { resolveKey } from '@habemus-papadum/aiui-viz/keys';
import { commandGroups, commandLayers, commandMachine, type Command } from './keyboard';

const commands: Command[] = [
  { id: 'collapse', group: 'Groups', label: 'Collapse all', key: 'c', run() {} },
  { id: 'expand', group: 'Groups', label: 'Expand all', key: 'e', run() {} },
  { id: 'inspect', group: 'View', label: 'Inspect', key: 'i', run() {} },
];
const layers = commandLayers(commands);
describe('Space command map through the actual AIUI key layer and mode engine', () => {
  it('opens from Space, narrows by group, executes and closes through one reducer', () => {
    const calls: string[] = [];
    const machine = commandMachine(commands, id => calls.push(id));
    const press = (key: string) => {
      const resolved = resolveKey(layers, { palette: String(machine.state().palette), enabled: machine.context().enabled }, key, 'down', false);
      if (typeof resolved === 'object') machine.dispatch(resolved.command);
      return resolved;
    };
    press(' '); expect(machine.state().palette).toBe('root');
    press('g'); expect(machine.state().palette).toBe('Groups');
    press('c'); expect(calls).toEqual(['collapse']); expect(machine.state().palette).toBe('closed');
    press('i'); expect(calls).toEqual(['collapse', 'inspect']);
  });
  it('refuses unavailable commands from keys and direct dispatch alike', () => {
    const calls: string[] = [];
    const machine = commandMachine(commands, id => calls.push(id));
    machine.setContext({ enabled: { collapse: false, expand: true, inspect: true } });
    expect(resolveKey(layers, { palette: 'closed', enabled: machine.context().enabled }, 'c', 'down', false)).toBe('swallow');
    machine.dispatch('action:collapse'); expect(calls).toEqual([]);
  });
  it('backs out one level and closes a pending palette on window blur', () => {
    const machine = commandMachine(commands, () => {});
    machine.dispatch('open'); machine.dispatch('group:Groups'); machine.dispatch('back');
    expect(machine.state().palette).toBe('root'); machine.dispatch('back');
    expect(machine.state().palette).toBe('closed'); machine.dispatch('open'); machine.dispatch('blur');
    expect(machine.state().palette).toBe('closed');
  });
  it('passes unbound keys and keyup, and suppresses repeated actions', () => {
    const state = { palette: 'closed', enabled: { collapse: true, expand: true, inspect: true } };
    expect(resolveKey(layers, state, 'z', 'down', false)).toBe('pass');
    expect(resolveKey(layers, state, 'c', 'up', false)).toBe('pass');
    expect(resolveKey(layers, state, 'c', 'down', true)).toBe('swallow');
    expect(resolveKey(layers, { ...state, palette: 'Groups' }, 'z', 'down', false)).toBe('swallow');
  });
  it('assigns distinct discoverable group keys even with shared initials', () => {
    const groups = commandGroups([{ ...commands[0], group: 'Source' }, { ...commands[1], group: 'Session' }]);
    expect(new Set(groups.map(g => g.key)).size).toBe(2);
  });
});

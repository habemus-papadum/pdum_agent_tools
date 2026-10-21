import type { KeyLayer } from '@habemus-papadum/aiui-viz/keys';
import { choice, createModeEngine } from '@habemus-papadum/aiui-viz/mode-engine';

export type Command = { id: string; group: string; label: string; key: string; icon?: string; description?: string;
  run: () => unknown; enabled?: () => boolean };
export type KeyState = { palette: string; enabled: Record<string, boolean> };

export function commandGroups(commands: readonly Command[]) {
  const used = new Set<string>();
  return [...new Set(commands.map(c => c.group))].map(name => {
    const key = [...name.toLowerCase(), ...'123456789'].find(c => /[a-z1-9]/.test(c) && !used.has(c))!;
    used.add(key);
    return { name, key, commands: commands.filter(c => c.group === name) };
  });
}

export function commandLayers(commands: readonly Command[]): KeyLayer<KeyState, string>[] {
  const groups = commandGroups(commands);
  const actionBindings = commands.map(c => ({ keys: [...new Set([c.key, c.key.toUpperCase()])],
    down: (s: KeyState, _key: string, repeat: boolean) => repeat || !s.enabled[c.id] ? 'swallow' as const : { command: `action:${c.id}` },
    hint: { key: c.key, label: c.label, icon: c.icon } }));
  return [
    ...groups.map(g => ({ name: `commands:${g.name}`, active: (s: KeyState) => s.palette === g.name,
      fallback: 'swallow' as const, bindings: [
        { keys: ['Escape', 'Backspace'], down: () => ({ command: 'back' }) },
        { keys: [' '], down: () => ({ command: 'close' }) },
        ...actionBindings.filter((_, i) => commands[i].group === g.name),
      ] })),
    { name: 'command-map', active: s => s.palette === 'root', fallback: 'swallow', bindings: [
      { keys: ['Escape', ' '], down: () => ({ command: 'close' }) },
      ...groups.map(g => ({ keys: [g.key, g.key.toUpperCase()], down: () => ({ command: `group:${g.name}` }),
        hint: { key: g.key, label: g.name } })), ...actionBindings,
    ] },
    { name: 'page', fallback: 'pass', bindings: [
      { keys: [' ', '?'], down: (_s, _key, repeat) => repeat ? 'swallow' : { command: 'open' }, hint: { key: 'Space', label: 'Command map' } },
      ...actionBindings,
    ] },
  ];
}

export function commandMachine(commands: readonly Command[], onAction: (id: string) => void) {
  const groups = commandGroups(commands);
  const reducers = Object.fromEntries(commands.map(c => [`action:${c.id}`, () => ({ palette: 'closed' })]));
  return createModeEngine({
    regions: { palette: choice(['closed', 'root', ...groups.map(g => g.name)], { blurExits: true }) },
    commands: { open: () => ({ palette: 'root' }), close: () => ({ palette: 'closed' }),
      back: s => ({ palette: s.palette === 'root' ? 'closed' : 'root' }),
      ...Object.fromEntries(groups.map(g => [`group:${g.name}`, () => ({ palette: g.name })])), ...reducers },
    available: Object.fromEntries(commands.map(c => [`action:${c.id}`, (_s, ctx: { enabled: Record<string, boolean> }) => ctx.enabled[c.id] ?? false])),
    escOrder: ['palette'],
  }, { context: { enabled: Object.fromEntries(commands.map(c => [c.id, true])) },
    onDispatch: event => { if (!event.refused && event.command.startsWith('action:')) onAction(event.command.slice(7)); } });
}

/** Durable view controls. These actions change the reader only; there is no provider mutation API. */
import {action, control, scope} from '@habemus-papadum/aiui-viz';
export const appScope = scope('native-history');
/** Provider filter for the captured catalog. */
export const provider = control({scope: appScope, value: 'all', options: ['all', 'claude', 'codex']});
/** Match catalog titles or native session identifiers. */
export const catalogQuery = control({scope: appScope, value: ''});
/** Match transcript text, native item or turn identifiers. */
export const query = control({scope: appScope, value: ''});
/** Show all items, a native message role, or tool-containing records (including Claude assistant/user blocks). */
export const kind = control({scope: appScope, value: 'all', options: ['all', 'user', 'assistant', 'tool']});
/** Inspector view. Raw opens exact native bytes parsed as JSON. */
export const inspector = control({scope: appScope, value: 'provenance', options: ['closed', 'provenance', 'raw']});
/** Show the provider catalog beside the transcript. */
export const sourcesOpen = control({scope: appScope, value: true});
export const selectedKey = appScope.durableSignal('selected-key', '');
export const focus = appScope.durableSignal('focused-item', {id: '', sequence: 0});
export const refreshSequence = appScope.durableSignal('refresh-sequence', 0);
/** Open one previously captured session or the explicitly synthetic renderer bench.
 * @example {"key":"codex-example"}
 */
export const openHistory = action({scope: appScope, name: 'open-history', group: 'history', params: {key: 'Catalog key or @specimen'}, run: args => {
  const key = String(args?.key ?? '');
  if (!/^[a-zA-Z0-9_.@-]+$/.test(key)) throw new Error('Use a key from the history catalog');
  selectedKey.set(key); query.set(''); kind.set('all'); focus.set(current => ({id: '', sequence: current.sequence + 1}));
  return {key, effect: 'Read captured history only'};
}});
/** Scroll to a transcript item. Identity is the exported document key plus native position. */
export const jump = action({scope: appScope, name: 'jump', group: 'navigation', params: {id: 'Projected item id from the history report'}, run: args => {
  const id = String(args?.id ?? '');
  if (!id) throw new Error('An item id is required');
  focus.set(current => ({id, sequence: current.sequence + 1}));
  return {id, effect: 'Move reader focus only'};
}});
/** Refresh the existing local export; this does not contact a provider or regenerate captures. */
export const refresh = action({scope: appScope, name: 'refresh-export', group: 'history', run: () => refreshSequence.set(value => value + 1)});
/** Open or close the raw inspector. */
export const toggleRaw = action({scope: appScope, name: 'toggle-raw', group: 'inspection', run: () => inspector.set(inspector.get() === 'raw' ? 'closed' : 'raw')});
/** Open or close the catalog. */
export const toggleSources = action({scope: appScope, name: 'toggle-sources', group: 'navigation', run: () => sourcesOpen.set(!sourcesOpen.get())});

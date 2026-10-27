/** Durable view controls. These actions change the reader only; there is no provider mutation API. */
import {action, control, scope} from '@habemus-papadum/aiui-viz';
export const appScope = scope('native-history');
const narrowInitialViewport = typeof window !== 'undefined' && window.innerWidth <= 700;
const initialQuery = new URLSearchParams(typeof window==='undefined'?'':window.location.search);
/** Provider filter for the captured catalog. */
export const provider = control({scope: appScope, value: 'all', options: ['all', 'claude', 'codex']});
/** Match catalog titles or native session identifiers. */
export const catalogQuery = control({scope: appScope, value: ''});
/** Match transcript text, native item or turn identifiers. */
export const query = control({scope: appScope, value: ''});
/** Show all items, a native message role, or tool-containing records (including Claude assistant/user blocks). */
export const kind = control({scope: appScope, value: 'all', options: ['all', 'user', 'assistant', 'tool', 'image', 'event', 'error']});
/** Fold explicit Codex commentary into work pills. Unknown Claude phases are never guessed. */
export const updatesAsPills = control({scope: appScope, value: false});
/** Each agent's item order, or producer calendar time where available. No silent fallback. */
export const mapAxis = control({scope: appScope, value: 'sequence', options: ['sequence', 'time']});
/** Metric shown in the navigator. Missing metrics remain visibly unavailable. */
export const mapTrack = control({scope: appScope, value: 'activity', options: ['activity', 'errors', 'duration', 'tokens', 'model', 'cost', 'context']});
/** Navigator width in CSS pixels. A display preference, not a data-loading limit. */
export const mapWidth = control({scope: appScope, value: 260, options: [180, 260, 360, 520, 720]});
/** Fold only gaps with no recorded activity across the selected lanes. */
export const compressGaps = control({scope: appScope, value: true});
/** Provisional fixed threshold in minutes; not a runtime inactivity policy. */
export const gapMinutes = control({scope: appScope, value: 30, options: [5, 15, 30, 60, 240, 1440]});
export const selectedFamilyId = appScope.durableSignal('selected-family', initialQuery.get('group')??'');
export const requestedExample = appScope.durableSignal('requested-example', initialQuery.get('example')||(initialQuery.get('group')?'@initial':''));
export const exampleNotice = appScope.durableSignal('example-notice','');
export const selectedLanes = appScope.durableSignal<string[] | null>('selected-lanes', null);
export const expandedGaps = appScope.durableSignal<string[]>('expanded-gaps', []);
export const standaloneKey = appScope.durableSignal('standalone-key', '');
/** Inspector view. Raw opens exact native bytes parsed as JSON. */
export const inspector = control({scope: appScope, value: narrowInitialViewport ? 'closed' : 'map', options: ['closed', 'map', 'provenance', 'raw', 'image']});
/** Outline elides all prose; compact shows excerpts; reading expands message bodies. Tools expand separately. */
export const density = control({scope: appScope, value: 'compact', options: ['outline', 'compact', 'reading']});
/** Number of native items mounted at once. This is display windowing, not backend pagination. */
export const windowSize = control({scope: appScope, value: 80, options: [80, 160, 320]});
export const windowStart = appScope.durableSignal('window-start', 0);
export const expanded = appScope.durableSignal<Record<string, boolean>>('expanded-items', {});
export const pinnedImage = appScope.durableSignal<{url?: string; reference?: string; label: string; origin?: string; qualification?: string} | null>('pinned-image', null);
/** Show the provider catalog beside the transcript. */
export const sourcesOpen = control({scope: appScope, value: !narrowInitialViewport});
export const selectedKey = appScope.durableSignal('selected-key', '');
export const focus = appScope.durableSignal<{id:string;sequence:number;align?:'start'|'center'}>('focused-item', {id: '', sequence: 0});
export const refreshSequence = appScope.durableSignal('refresh-sequence', 0);
/** Open one previously captured session or the explicitly synthetic renderer bench.
 * @example {"key":"codex-example"}
 */
export const openHistory = action({scope: appScope, name: 'open-history', group: 'history', params: {key: 'Catalog key or @specimen'}, run: args => {
  const key = String(args?.key ?? '');
  if (!/^[a-zA-Z0-9_.@-]+$/.test(key)) throw new Error('Use a key from the history catalog');
  selectedFamilyId.set(''); selectedLanes.set(null); expandedGaps.set([]); standaloneKey.set(key);
  requestedExample.set('');exampleNotice.set('');
  selectedKey.set(key); query.set(''); kind.set('all'); windowStart.set(0);
  expanded.set({}); pinnedImage.set(null); if (key === '@specimen') density.set('reading');
  focus.set(current => ({id: '', sequence: current.sequence + 1}));
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
/** Override expansion for one native item without altering its contents or neighbouring items. */
export const expandItem = action({scope: appScope, name: 'expand-item', group: 'presentation', params: {id: 'Projected item identity', open: 'True to expand, false to collapse'}, run: args => {
  const id = String(args?.id ?? ''); if (!id) throw new Error('An item id is required');
  expanded.set(value => ({...value, [id]: args?.open === true}));
}});
/** Clear per-item exceptions and choose a transcript-wide level of detail. */
export const setDensity = action({scope: appScope, name: 'set-density', group: 'presentation', params: {level: 'outline, compact or reading'}, run: args => {
  density.set(String(args?.level ?? 'compact')); expanded.set({});
}});
/** Pin a captured image or unavailable reference. Pinning does not retrieve a remote URL. */
export const pinImage = action({scope: appScope, name: 'pin-image', group: 'inspection', params: {url: 'Captured image URL', reference: 'Original reference', label: 'Image label', origin: 'Native image origin'}, run: args => {
  pinnedImage.set({url: typeof args?.url === 'string' ? args.url : undefined, reference: typeof args?.reference === 'string' ? args.reference : undefined,
    label: String(args?.label ?? 'Image'), origin: String(args?.origin ?? ''), qualification: typeof args?.qualification === 'string' ? args.qualification : undefined}); inspector.set('image');
}});
/** Expand or refold one navigator time gap, keeping the original time interval intact. */
export const toggleGap = action({scope: appScope, name: 'toggle-gap', group: 'navigation', params: {id: 'Gap identity from the navigator'}, run: args => {
  const id = String(args?.id ?? ''); if (!id) throw new Error('A gap id is required');
  expandedGaps.set(ids=>ids.includes(id)?ids.filter(value=>value!==id):[...ids,id]);
}});
/** Return to standalone captures without changing any source history. */
export const leaveFamily = action({scope: appScope, name: 'leave-family', group: 'history', run: () => {
  selectedFamilyId.set(''); selectedKey.set(standaloneKey.get()); selectedLanes.set(null); expandedGaps.set([]);
  requestedExample.set('');exampleNotice.set('');
  query.set(''); kind.set('all'); windowStart.set(0); focus.set(value=>({id:'',sequence:value.sequence+1}));
}});

/** Actual Mosaic plots: shared crossfilter, category highlight and adopted dimensions. */
import { MosaicView } from '@habemus-papadum/aiui-viz/mosaic';
import { rectX, from, count, toggleY, highlight, width, height, marginLeft, marginBottom, xLabel, yLabel, style } from '@uwdata/vgplot';
import { For, Show } from 'solid-js';
import { graph } from '../graph';
import { appScope, runtime } from '../store';

const fields = ['provider','host','status'] as const;
export function MosaicFacets() {
  return <Show when={graph().database.state() === 'ready' && runtime.engine}><div class="mosaic-facets"><For each={fields}>{field => <section class="mosaic-facet"><h3>{field === 'status' ? 'Execution state' : field}</h3><MosaicView scope={appScope} name={`${field}-chart`} coordinator={runtime.engine!.coordinator} spec={() => [
    rectX(from('agents', { filterBy: runtime.engine!.selection }), { y: field, x: count(), fill: 'var(--ink-muted)', inset: 1 }),
    toggleY({ as: runtime.engine!.categories[field] }),
    highlight({ by: runtime.engine!.categories[field], opacity: .22 }),
    width(290), height(field === 'status' ? 150 : 130), marginLeft(95), marginBottom(25), xLabel('agents'), yLabel(null),
    style({ background: 'transparent', color: 'var(--ink)', fontSize: '10px', fontFamily: 'var(--stack-sans)' }),
  ]}/></section>}</For></div><p class="mosaic-help">Click bars to select categories; modifier keys support multiple categories. All charts and tools share the same selection.</p></Show>;
}

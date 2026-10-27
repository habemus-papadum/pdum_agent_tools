/** Pure sequence/time geometry. Unknown clocks never acquire invented positions. */
import type {HistoryItem} from './native';
import {failed, itemKind, narrative} from './presentation';

export interface TimelineLane {key: string; items: readonly HistoryItem[];}
export interface TimeExtent {startMs: number; endMs: number; kind: 'interval' | 'instant' | 'start-only' | 'end-only';}
export interface TimeSegment {startMs: number; endMs: number; offsetMs: number; visibleMs: number; kind: 'activity' | 'gap'; gapId?: string;}
export interface TimeGap {
  id: string; startMs: number; endMs: number; elapsedMs: number; visibleMs: number; removedMs: number;
  compressed: boolean; expanded: boolean; start: number; end: number;
}
export interface TimeAxis {
  minMs: number | null; maxMs: number | null; rawDurationMs: number; visibleDurationMs: number;
  gapThresholdMs: number | null; segments: TimeSegment[]; gaps: TimeGap[];
  knownItems: number; unknownItems: number; invalidIntervals: number;
}
export interface TimeAxisOptions {gapThresholdMs?: number | null; expandedGapIds?: Iterable<string>;}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

/** A reported duration never manufactures an endpoint or a global timestamp. */
export function timeExtent(item: HistoryItem): TimeExtent | null {
  const {startedAtMs: start, completedAtMs: end} = item.timing;
  if (finite(start) && finite(end)) return end < start ? null : {startMs: start, endMs: end, kind: start === end ? 'instant' : 'interval'};
  if (finite(start)) return {startMs: start, endMs: start, kind: 'start-only'};
  if (finite(end)) return {startMs: end, endMs: end, kind: 'end-only'};
  return null;
}

/** Build once from ALL records in the selected lanes, before applying an item filter.
 * Busy intervals are unioned across lanes; one agent's gap cannot hide another's work.
 * The manual threshold both selects gaps and sets their retained display duration.
 */
export function buildTimeAxis(lanes: readonly TimelineLane[], options: TimeAxisOptions = {}): TimeAxis {
  const threshold = options.gapThresholdMs === null ? null : Math.max(1, finite(options.gapThresholdMs) ? options.gapThresholdMs : 60000);
  const expanded = new Set(options.expandedGapIds ?? []);
  const intervals: TimeExtent[] = [];
  let unknownItems = 0, invalidIntervals = 0;
  for (const lane of lanes) for (const item of lane.items) {
    const extent = timeExtent(item);
    if (extent) intervals.push(extent);
    else {
      unknownItems += 1;
      if (finite(item.timing.startedAtMs) && finite(item.timing.completedAtMs)) invalidIntervals += 1;
    }
  }
  intervals.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  if (!intervals.length) return {minMs: null, maxMs: null, rawDurationMs: 0, visibleDurationMs: 0,
    gapThresholdMs: threshold, segments: [], gaps: [], knownItems: 0, unknownItems, invalidIntervals};
  const occupied: {startMs: number; endMs: number}[] = [];
  for (const interval of intervals) {
    const previous = occupied.at(-1);
    if (previous && interval.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, interval.endMs);
    else occupied.push({startMs: interval.startMs, endMs: interval.endMs});
  }
  const minMs = occupied[0].startMs, maxMs = occupied.at(-1)!.endMs;
  const segments: TimeSegment[] = [], gaps: TimeGap[] = [];
  let offset = 0;
  const append = (startMs: number, endMs: number, visibleMs: number, kind: 'activity' | 'gap', gapId?: string) => {
    segments.push({startMs, endMs, offsetMs: offset, visibleMs, kind, gapId}); offset += visibleMs;
  };
  for (let index = 0; index < occupied.length; index++) {
    const interval = occupied[index], previous = occupied[index - 1];
    if (previous && interval.startMs > previous.endMs) {
      const startMs = previous.endMs, endMs = interval.startMs, elapsedMs = endMs - startMs;
      const id = `${startMs}:${endMs}`, isExpanded = expanded.has(id);
      const eligible = threshold !== null && elapsedMs > threshold;
      const visibleMs = eligible && !isExpanded ? threshold! : elapsedMs;
      append(startMs, endMs, visibleMs, 'gap', id);
      if (eligible) gaps.push({id, startMs, endMs, elapsedMs, visibleMs, removedMs: elapsedMs - visibleMs,
        compressed: !isExpanded, expanded: isExpanded, start: 0, end: 0});
    }
    append(interval.startMs, interval.endMs, interval.endMs - interval.startMs, 'activity');
  }
  const axis: TimeAxis = {minMs, maxMs, rawDurationMs: maxMs - minMs, visibleDurationMs: offset,
    gapThresholdMs: threshold, segments, gaps, knownItems: intervals.length, unknownItems, invalidIntervals};
  for (const gap of gaps) {gap.start = forwardTime(axis, gap.startMs) ?? 0; gap.end = forwardTime(axis, gap.endMs) ?? 0;}
  return axis;
}

/** Raw Unix milliseconds -> normalized display coordinate, preserving explicit gap compression. */
export function forwardTime(axis: TimeAxis, timeMs: number): number | null {
  if (axis.minMs === null || axis.maxMs === null || !finite(timeMs)) return null;
  if (!axis.visibleDurationMs) return 0;
  const value = clamp(timeMs, axis.minMs, axis.maxMs);
  let left = 0, right = axis.segments.length - 1;
  while (left < right) {const mid = Math.floor((left + right) / 2); if (axis.segments[mid].endMs < value) left = mid + 1; else right = mid;}
  const segment = axis.segments[left], rawMs = segment.endMs - segment.startMs;
  return clamp((segment.offsetMs + (rawMs ? (value - segment.startMs) / rawMs * segment.visibleMs : 0)) / axis.visibleDurationMs);
}

/** Normalized display coordinate -> raw Unix milliseconds, including inside compressed gaps. */
export function inverseTime(axis: TimeAxis, position: number): number | null {
  if (axis.minMs === null || axis.maxMs === null || !finite(position)) return null;
  if (!axis.visibleDurationMs) return axis.minMs;
  const value = clamp(position) * axis.visibleDurationMs;
  let left = 0, right = axis.segments.length - 1;
  while (left < right) {const mid = Math.floor((left + right) / 2); if (axis.segments[mid].offsetMs + axis.segments[mid].visibleMs < value) left = mid + 1; else right = mid;}
  const segment = axis.segments[left];
  return segment.startMs + (segment.visibleMs ? (value - segment.offsetMs) / segment.visibleMs * (segment.endMs - segment.startMs) : 0);
}

export type TimelineMode = 'sequence' | 'time';
export interface TimelineBin {
  index: number; y: number; height: number; firstItemId: string | null; lastItemId: string | null;
  firstOrdinal: number | null; lastOrdinal: number | null; count: number;
  user: number; assistant: number; tool: number; error: boolean; compaction: boolean; image: boolean;
}
export interface TimelineGeometryOptions {
  mode: TimelineMode; axis?: TimeAxis; height?: number; bins?: number;
  include?: (item: HistoryItem) => boolean;
}

/** Six categorical SVG paths per lane, independent of trace length. */
export function timelinePaths(bins: readonly TimelineBin[]) {
  const paths: Record<string, string[]> = {user: [], assistant: [], tool: [], error: [], compaction: [], image: []};
  const rect = (x: number, y: number, width: number, height: number) => `M${x} ${y.toFixed(2)}h${width}v${height.toFixed(2)}h-${width}Z`;
  for (const bin of bins) {
    if (bin.user) paths.user.push(rect(4, bin.y, 24, bin.height));
    if (bin.assistant) paths.assistant.push(rect(32, bin.y, 30, bin.height));
    if (bin.tool) paths.tool.push(rect(66, bin.y, 21, bin.height));
    if (bin.error) paths.error.push(rect(91, bin.y, 2, Math.max(1, bin.height)));
    if (bin.compaction) paths.compaction.push(rect(94, bin.y, 2, Math.max(1, bin.height)));
    if (bin.image) paths.image.push(rect(97, bin.y, 2, Math.max(1, bin.height)));
  }
  return Object.entries(paths).map(([kind, commands]) => ({kind, path: commands.join('')}));
}

/** Sequence uses each lane's OWN ordinal. Time uses a shared, pre-filter axis.
 * Unknown or invalid clock records are returned separately, never distributed over time.
 */
export function timelineGeometry(lanes: readonly TimelineLane[], options: TimelineGeometryOptions) {
  if (options.mode === 'time' && !options.axis) throw new Error('Build a shared time axis from all selected lane records before filtering.');
  const height = Math.max(1, options.height ?? 600), count = Math.max(1, Math.trunc(options.bins ?? 160));
  return lanes.map(lane => {
    const bins: TimelineBin[] = Array.from({length: count}, (_, index) => ({index, y: index / count * height,
      height: Math.max(.6, height / count - .5), firstItemId: null, lastItemId: null,
      firstOrdinal: null, lastOrdinal: null, count: 0, user: 0, assistant: 0, tool: 0, error: false, compaction: false, image: false}));
    const unknownItems: HistoryItem[] = [];
    let includedItems = 0, positionedItems = 0;
    lane.items.forEach((item, ordinal) => {
      if (options.include && !options.include(item)) return;
      includedItems += 1;
      let start: number, end: number;
      if (options.mode === 'sequence') start = end = lane.items.length > 1 ? ordinal / (lane.items.length - 1) : 0;
      else {
        const extent = timeExtent(item);
        if (!extent) {unknownItems.push(item); return;}
        const left = forwardTime(options.axis!, extent.startMs), right = forwardTime(options.axis!, extent.endMs);
        if (left === null || right === null) {unknownItems.push(item); return;}
        start = left; end = right;
      }
      positionedItems += 1;
      const first = Math.min(count - 1, Math.floor(clamp(start) * count)), last = Math.min(count - 1, Math.floor(clamp(end) * count));
      for (let index = first; index <= last; index++) {
        const bin = bins[index];
        if (!bin.firstItemId) {bin.firstItemId = item.id; bin.firstOrdinal = ordinal;}
        bin.lastItemId = item.id; bin.lastOrdinal = ordinal; bin.count += 1;
        if (narrative(item)) {if (item.role === 'user') bin.user += 1; else bin.assistant += 1;} else bin.tool += 1;
        bin.error ||= failed(item); bin.compaction ||= itemKind(item) === 'compaction';
        bin.image ||= item.blocks.some(block => block.kind === 'image');
      }
    });
    return {key: lane.key, bins, paths: timelinePaths(bins), includedItems, positionedItems,
      unknownItems, unknownItemIds: unknownItems.map(item => item.id), totalItems: lane.items.length};
  });
}

/** Click a lane by its own sequence or shared time coordinate; last-record jumps remain reachable. */
export function nearestTimelineItem(lane: TimelineLane, position: number, options: {mode: TimelineMode; axis?: TimeAxis; include?: (item: HistoryItem) => boolean}): HistoryItem | null {
  const target = clamp(position);
  let best: HistoryItem | null = null, distance = Number.POSITIVE_INFINITY;
  lane.items.forEach((item, index) => {
    if (options.include && !options.include(item)) return;
    let start: number, end: number;
    if (options.mode === 'sequence') start = end = lane.items.length > 1 ? index / (lane.items.length - 1) : 0;
    else {
      const extent = timeExtent(item);
      if (!extent || !options.axis) return;
      const a = forwardTime(options.axis, extent.startMs), b = forwardTime(options.axis, extent.endMs);
      if (a === null || b === null) return; start = a; end = b;
    }
    const gap = target < start ? start - target : target > end ? target - end : 0;
    if (gap <= distance) {best = item; distance = gap;}
  });
  return best;
}

/** Display-only projections. Never reorder, merge native records, or infer a missing phase. */
import {itemHasError, object, type HistoryItem} from './native';
export type Density = 'outline' | 'compact' | 'reading';
export interface PresentationOptions {updatesAsPills?: boolean;}
export function narrative(item: HistoryItem, options: PresentationOptions = {}): boolean {
  if (item.operation || (options.updatesAsPills && item.phase === 'commentary')) return false;
  return item.blocks.some(block => block.kind === 'markdown') ||
    (item.role !== 'tool' && !item.blocks.some(block => block.kind === 'result') && item.blocks.some(block => block.kind === 'image'));
}
export function itemKind(item: HistoryItem): string {
  const raw = object(item.raw), type = String(raw.type ?? '');
  if (item.operation?.kind.startsWith('child-')) return 'agent';
  if (item.operation?.kind === 'sleep') return 'sleep';
  if (item.operation?.kind === 'compaction' || item.operation?.kind === 'compact-command') return 'compaction';
  if (item.operation?.kind === 'background-request' || item.operation?.kind === 'task-notification') return 'background';
  if (item.operation) return 'event';
  if (type === 'contextCompaction') return 'compaction';
  if (type === 'fileChange') return 'file';
  if (type === 'commandExecution') return 'command';
  if (item.childIds.length) return 'agent';
  if (narrative(item)) return item.role === 'user' ? 'user' : 'assistant';
  if (item.blocks.some(block => block.kind === 'thinking')) return 'thinking';
  if (item.blocks.some(block => block.kind === 'image')) return 'image';
  return 'tool';
}
export function phaseLabel(item: HistoryItem): string | null {
  if (item.phase === 'commentary') return 'update';
  if (item.phase === 'partial_answer') return 'partial';
  if (item.phase === 'final_answer' || item.phase === 'final') return 'final';
  return item.phase; // Source-reported values only; position/stop reason never establishes finality.
}
export function failed(item: HistoryItem): boolean {
  return itemHasError(item);
}
export function excerpt(item: HistoryItem, limit = 240): string {
  const raw = object(item.raw);
  const text = item.blocks.filter(block => block.kind === 'markdown').map(block => block.text ?? '').join(' ') ||
    (typeof raw.command === 'string' ? raw.command : '') ||
    item.blocks.map(block => block.label || block.text || '').join(' ');
  const clean = text.replace(/<image[^>]*>/g, '[image]').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean || item.label;
}
export function shortName(value: string): string {return value.split(/[\\/]/).filter(Boolean).at(-1) || value;}
export function pillLabel(item: HistoryItem): string {
  const raw = object(item.raw), kind = itemKind(item);
  if (item.operation) return item.operation.label;
  if (item.phase === 'commentary') return excerpt(item, 52);
  if (kind === 'file') {
    const changes = Array.isArray(raw.changes) ? raw.changes : [];
    return changes.length === 1 ? shortName(String(object(changes[0]).path ?? 'file')) : `${changes.length} files`;
  }
  if (kind === 'command') return excerpt(item, 52);
  if (kind === 'compaction') return 'Context compacted';
  if (kind === 'thinking') return 'Reasoning';
  return item.blocks.find(block => block.kind === 'tool')?.label || item.label;
}
export function features(item: HistoryItem): string[] {
  const text = item.blocks.map(block => block.text ?? '').join('\n');
  return [
    /```mermaid\b/.test(text) ? 'diagram' : '',
    /\$[^$\n]+\$|\\\[|\\\(/.test(text) ? 'math' : '',
    item.blocks.some(block => block.kind === 'image') || /!\[[^\]]*\]\(/.test(text) ? 'image' : '',
    failed(item) ? 'error' : '', item.childIds.length ? 'related' : '',
  ].filter(Boolean);
}
export interface DisplayRow {id: string; kind: 'message' | 'activity'; items: HistoryItem[];}
/** Consecutive work shares a row, without moving it across a native turn or message. */
export function displayRows(items: HistoryItem[], options: PresentationOptions = {}): DisplayRow[] {
  const rows: DisplayRow[] = [];
  for (const item of items) {
    const kind = narrative(item, options) ? 'message' : 'activity';
    const previous = rows.at(-1);
    if (kind === 'activity' && previous?.kind === kind && previous.items[0].turnId === item.turnId) previous.items.push(item);
    else rows.push({id: item.id, kind, items: [item]});
  }
  return rows;
}

/** Human-sized units for an explicitly labelled duration; null remains unknown and zero stays zero. */
export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return 'unknown';
  const sign = milliseconds < 0 ? '−' : '', value = Math.abs(milliseconds);
  if (value < 1000) return `${sign}${Math.round(value)} ms`;
  if (value < 60000) return `${sign}${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
  if (value < 3600000) return `${sign}${(value / 60000).toFixed(1)} min`;
  return `${sign}${(value / 3600000).toFixed(1)} h`;
}
export function itemWindow(items: HistoryItem[], start: number, size = 80) {
  const safeSize = Math.max(1, Math.trunc(size));
  const safeStart = Math.max(0, Math.min(Math.trunc(start), Math.max(0, items.length - 1)));
  return {start: safeStart, end: Math.min(items.length, safeStart + safeSize), total: items.length,
    items: items.slice(safeStart, safeStart + safeSize)};
}
/** Fixed number of SVG bins: full filtered chronology remains navigable at any length. */
export function mapBins(items: HistoryItem[], count = 160) {
  const width = Math.max(1, Math.ceil(items.length / count));
  const bins: {start: number; end: number; y: number; height: number; id: string; user: number; assistant: number; tool: number; error: boolean; compaction: boolean; image: boolean}[] = [];
  for (let start = 0; start < items.length; start += width) {
    const sample = items.slice(start, start + width);
    bins.push({start, end: start + sample.length, y: start / items.length * 600,
      height: Math.max(.7, sample.length / items.length * 600 - 1), id: sample[0].id,
      user: sample.filter(item => narrative(item) && item.role === 'user').length,
      assistant: sample.filter(item => narrative(item) && item.role === 'assistant').length,
      tool: sample.filter(item => !narrative(item)).length, error: sample.some(failed),
      compaction: sample.some(item => itemKind(item) === 'compaction'), image: sample.some(item => features(item).includes('image'))});
  }
  return bins;
}

/** Six SVG paths instead of hundreds of reactive rectangles; identical bin geometry. */
export function mapPaths(bins: ReturnType<typeof mapBins>) {
  const paths: Record<string, string[]> = {user:[],assistant:[],tool:[],error:[],compaction:[],image:[]};
  const rect=(x:number,y:number,w:number,h:number)=>`M${x} ${y.toFixed(2)}h${w}v${h.toFixed(2)}h-${w}Z`;
  for (const bin of bins) {
    if(bin.user) paths.user.push(rect(4,bin.y,24,bin.height));
    if(bin.assistant) paths.assistant.push(rect(32,bin.y,30,bin.height));
    if(bin.tool) paths.tool.push(rect(66,bin.y,21,bin.height));
    const marker=bin.error?'error':bin.compaction?'compaction':bin.image?'image':null;
    if(marker) paths[marker].push(rect(91,bin.y,7,Math.max(2,bin.height)));
  }
  return Object.entries(paths).map(([kind,commands])=>({kind,path:commands.join('')}));
}

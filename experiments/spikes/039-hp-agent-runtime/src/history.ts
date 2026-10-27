import type { Json, SavedThread, UsageRecord } from './runtime.ts';

/** Serializable history facts; no execution owner or storage implementation is required. */
export interface HistorySource {
  runId: string;
  snapshots(): SavedThread[];
  usages: readonly UsageRecord[];
}

/** Rows named by the existing v5 history contract, with absent fields left NULL by the writer. */
export function historyRows(runtime: HistorySource): { schemaVersion: 5; tables: Record<string, Json[]> } {
  const tables: Record<string, Json[]> = { threads: [], turns: [], items: [], item_blobs: [], responses: [], fork_edges: [], spawn_edges: [], coverage: [], provenance: [] };
  const source = { source_id: runtime.runId, source: 'hp-agent', origin: 'runtime' };
  const snapshots = runtime.snapshots();
  const depth = (id: string): number => {
    const saved = snapshots.find((s) => s.thread.id === id);
    const parent = saved?.thread.parentThreadId ?? saved?.thread.forkedFromId;
    return parent ? 1 + depth(parent) : 0;
  };
  tables.provenance!.push({ source_id: source.source_id, host_id: 'hp-runtime', agent: 'hp-agent', root: '/', agent_versions: JSON.stringify({ runtime: 'spike-039' }), schema_version: 5, ingester_version: 'spike-039', ingested_at: new Date().toISOString(), run_id: runtime.runId });
  for (const saved of snapshots) {
    const t = saved.thread;
    tables.threads!.push({ ...source, thread_id: t.id, session_id: t.sessionId, forked_from_id: t.forkedFromId, parent_thread_id: t.parentThreadId,
      lineage_id: t.sessionId, lineage_depth: depth(t.id), model: t.model, cwd: t.cwd, created_at: date(t.createdAt), updated_at: date(t.updatedAt), cli_version: 'hp-agent-spike-039', source_kind: 'appServer', model_provider: 'openai', originator: 'hp-agent-spike', thread_source: 'hp-agent', history_mode: 'legacy', in_window: true });
    for (const turn of t.turns) {
      const origin = saved.inheritedTurnIds.includes(turn.id) ? 'copied-context' : 'runtime';
      const ids = { ...source, origin, thread_id: t.id, turn_id: turn.id };
      tables.turns!.push({ ...ids, root_turn_id: turn.rootTurnId, status: turn.status, error_message: turn.error?.message ?? null, started_at: date(turn.startedAt), completed_at: date(turn.completedAt), duration_ms: turn.durationMs, model: t.model, cwd: t.cwd });
      for (const item of turn.items) {
        let output = Array.isArray(item.contentItems) ? item.contentItems.map((c) => String(c.text ?? '')).join('') : null;
        const commandTool = item.tool === 'exec_command' || item.tool === 'write_stdin';
        let exitCode: number | null = null;
        if (commandTool && output !== null) {
          try {
            const result = JSON.parse(output) as Json;
            if (typeof result.output === 'string') output = result.output;
            if (typeof result.exit_code === 'number') exitCode = result.exit_code;
          } catch { /* Dispatch failures may contain a plain-text error instead of a result. */ }
        }
        const itemType = commandTool ? 'commandExecution' : item.tool === 'apply_patch' ? 'fileChange'
          : item.type === 'dynamicToolCall' ? 'toolCall' : item.type;
        const commandArgs = item.arguments && typeof item.arguments === 'object' ? item.arguments as Json : {};
        const text = item.type === 'userMessage' && Array.isArray(item.content)
          ? item.content.filter((part) => part.type === 'text').map((part) => String(part.text)).join('\n')
          : typeof item.text === 'string' ? item.text : null;
        tables.items!.push({ ...ids, item_id: item.id, item_type: itemType, status: item.status ?? turn.status, tool: item.tool ?? null, command: commandTool ? commandArgs.cmd ?? null : null, exit_code: exitCode,
          output_bytes: output === null ? null : new TextEncoder().encode(output).length, text, text_len: text === null ? null : [...text].length, item_json_bytes: new TextEncoder().encode(JSON.stringify(item)).length });
        tables.item_blobs!.push({ ...ids, item_id: item.id, item_json: JSON.stringify(item) });
      }
    }
    if (t.forkedFromId) tables.fork_edges!.push({ ...source, parent_thread_id: t.forkedFromId, child_thread_id: t.id, kind: 'fork', evidence: 'runtime', ambiguous: false, inherited_records: saved.inheritedTurnIds.length, child_started_at: date(t.createdAt) });
    if (t.parentThreadId) tables.spawn_edges!.push({ ...source, parent_thread_id: t.parentThreadId, child_thread_id: t.id, status: t.turns.at(-1)?.status ?? 'idle' });
    tables.coverage!.push({ ...source, thread_id: t.id, in_window: true, in_catalogue: true, in_projection: true, rollout_format: 'hp-agent-journal-v1', projection_turns: t.turns.length, projection_items: t.turns.reduce((sum, turn) => sum + turn.items.length, 0), compactions: 0, unknown_line_types: 0 });
  }
  for (const [ordinal, record] of runtime.usages.entries()) {
    const u = record.usage;
    tables.responses!.push({ ...source, rollout_ordinal: ordinal + 1, thread_id: record.threadId, turn_id: record.turnId, root_turn_id: record.turnId, response_id: u.responseId, ts: record.ts, model: u.model, input_tokens: u.inputTokens, cached_input_tokens: u.cachedInputTokens,
      cache_write_input_tokens: u.cacheWriteTokens, output_tokens: u.outputTokens, reasoning_output_tokens: u.reasoningOutputTokens ?? null, total_tokens: u.inputTokens + u.outputTokens });
  }
  return { schemaVersion: 5, tables };
}
function date(seconds: number | null): string | null { return seconds === null ? null : new Date(seconds * 1000).toISOString(); }

export function historySummary(saved: SavedThread[]) {
  return { threads: saved.length, turns: saved.reduce((sum, s) => sum + s.thread.turns.length, 0), items: saved.reduce((sum, s) => sum + s.thread.turns.reduce((n, t) => n + t.items.length, 0), 0) };
}

import type OpenAI from 'openai';
import type { AgentRuntime } from '../../039-hp-agent-runtime/src/runtime.ts';
import type { NativeItem } from '../../038-hp-sdk-fit/src/connector.ts';

/** Host-created authenticated client; this adapter has no credential or transport code. */
export type CompactionClient = Pick<OpenAI, 'responses'>;
export interface CompactionUsage {
  endpoint: 'responses.compact';
  responseId: string;
  threadId: string;
  afterTurnId: string | null;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  raw: OpenAI.Responses.ResponseUsage;
}
export interface CompactionOutcome {
  status: 'applied' | 'discarded';
  reason: 'thread_changed' | null;
  capturedAt: string;
  originalContext: NativeItem[];
  nextContext: NativeItem[];
  provider: OpenAI.Responses.CompactedResponse;
  usage: CompactionUsage;
}

/**
 * Compact an idle thread using full native context, then apply only if still current.
 * The returned provider window is canonical: never extract only its compaction item.
 * Discarded results still carry usage so a concurrent turn cannot erase paid work.
 */
export async function compactIdleThread(
  runtime: AgentRuntime,
  threadId: string,
  client: CompactionClient,
  options: { signal?: AbortSignal; instructions?: string } = {},
): Promise<CompactionOutcome> {
  const before = runtime.read(threadId);
  if (before.status && (before.status as NativeItem).type !== 'idle') throw new Error('Compaction requires an idle thread');
  const originalContext = runtime.context(threadId);
  const originalState = JSON.stringify({ turns: before.turns, context: originalContext });
  const instructions = options.instructions ?? runtime.options.instructions;
  const response = await client.responses.compact({
    model: before.model,
    input: structuredClone(originalContext) as unknown as OpenAI.Responses.ResponseInputItem[],
    ...(instructions ? { instructions } : {}),
    service_tier: 'default',
  }, { ...(options.signal ? { signal: options.signal } : {}), maxRetries: 0 });
  const raw = response.usage;
  const inputDetails = raw.input_tokens_details as unknown as NativeItem;
  const outputDetails = raw.output_tokens_details as unknown as NativeItem;
  const usage: CompactionUsage = {
    endpoint: 'responses.compact', responseId: response.id, threadId,
    afterTurnId: before.turns.at(-1)?.id ?? null, model: before.model,
    inputTokens: raw.input_tokens, cachedInputTokens: Number(inputDetails.cached_tokens ?? 0),
    cacheWriteTokens: Number(inputDetails.cache_write_tokens ?? 0), outputTokens: raw.output_tokens,
    reasoningTokens: Number(outputDetails.reasoning_tokens ?? 0), raw: structuredClone(raw),
  };
  const nextContext = structuredClone(response.output) as unknown as NativeItem[];
  const current = runtime.read(threadId);
  const changed = (current.status as NativeItem).type !== 'idle'
    || JSON.stringify({ turns: current.turns, context: runtime.context(threadId) }) !== originalState;
  if (!changed) runtime.replaceContext(threadId, nextContext, `responses.compact:${response.id}`);
  return {
    status: changed ? 'discarded' : 'applied', reason: changed ? 'thread_changed' : null,
    capturedAt: new Date().toISOString(), originalContext, nextContext,
    provider: structuredClone(response), usage,
  };
}

/** Bytes/items are observable facts; neither is a full-context token count. */
export function inspectContext(input: NativeItem[]) {
  const counts: Record<string, number> = {};
  let opaqueReasoningItems = 0;
  let opaqueCompactionItems = 0;
  for (const item of input) {
    const type = typeof item.type === 'string' ? item.type : 'message';
    counts[type] = (counts[type] ?? 0) + 1;
    if (typeof item.encrypted_content === 'string' && item.encrypted_content.length) {
      if (type === 'reasoning') opaqueReasoningItems++;
      if (type === 'compaction') opaqueCompactionItems++;
    }
  }
  return {
    items: input.length, counts,
    serializedBytes: new TextEncoder().encode(JSON.stringify(input)).byteLength,
    opaqueReasoningItems, opaqueCompactionItems,
    fullContextTokens: null,
    tokenCoverage: 'Not measured; serialized bytes and opaque item lengths are not token counts.',
  };
}

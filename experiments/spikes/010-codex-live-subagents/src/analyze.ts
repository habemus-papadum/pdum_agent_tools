import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type Data = Record<string, any>;

export function analyze(directory: string): Data {
  const file = join(directory, "level2.jsonl");
  let malformedRecords = 0;
  const records: Data[] = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Data]; } catch { malformedRecords++; return []; }
  }) : [];
  const flows = new Map<string, Data>();
  const pending = new Map<string, Data[]>();
  const responseRequests = new Map<string, Data>();
  const completedIds = new Set<string>();
  const requests: Data[] = [];
  const responses: Data[] = [];
  const calls: Data[] = [];
  const threadId = (flow: Data | undefined) => flow?.headers?.["thread-id"] ?? flow?.headers?.["session-id"] ?? flow?.headers?.session_id;
  for (const record of records) {
    if (record.kind === "request") flows.set(record.flow_id, record);
    const body = record.kind === "sse" ? record.data : record.body;
    if (body?.type === "response.create" && record.from_client || record.kind === "request_body" && body?.model) {
      const flow = flows.get(record.flow_id);
      const request = { flow: record.flow_id, threadId: threadId(flow), parentId: flow?.headers?.["x-codex-parent-thread-id"], subagent: flow?.headers?.["x-openai-subagent"], model: body.model, effort: body.reasoning?.effort, serviceTier: body.service_tier, warmup: body.generate === false, previousResponseId: body.previous_response_id, time: record.time };
      requests.push(request);
      const queue = pending.get(record.flow_id) ?? [];
      queue.push(request);
      pending.set(record.flow_id, queue);
    }
    if (body?.type === "response.output_item.done" && ["function_call", "custom_tool_call"].includes(body.item?.type)) {
      let argumentsValue: unknown = body.item.arguments ?? body.item.input;
      if (typeof argumentsValue === "string") {
        try { argumentsValue = JSON.parse(argumentsValue); } catch { }
      }
      calls.push({ flow: record.flow_id, threadId: threadId(flows.get(record.flow_id)), name: body.item.name, namespace: body.item.namespace, callId: body.item.call_id, arguments: argumentsValue });
    }
    if (body?.type === "response.created" && body.response?.id && !responseRequests.has(body.response.id)) {
      const request = pending.get(record.flow_id)?.shift();
      if (request) responseRequests.set(body.response.id, request);
    }
    if (body?.type === "response.completed" && !completedIds.has(body.response?.id)) {
      completedIds.add(body.response?.id);
      const request = responseRequests.get(body.response?.id);
      const usage = body.response?.usage;
      const model = request?.model ?? body.response?.model;
      const rates = model === "gpt-6-sol" ? [2, 0.2, 10, 2.5] : model === "gpt-6-luna" ? [0.1, 0.01, 0.5, 0.125] : undefined;
      const input = usage?.input_tokens ?? 0;
      const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
      const writes = usage?.input_tokens_details?.cache_write_tokens ?? 0;
      const output = usage?.output_tokens ?? 0;
      const pricingSupported = Boolean(request && rates && model === body.response?.model && usage && input <= 272_000 && input >= cached + writes && (body.response?.service_tier === "default" || request.warmup && body.response?.service_tier === "auto") && !request.serviceTier);
      const estimate = pricingSupported ? ((input - cached - writes) * rates![0]! + cached * rates![1]! + output * rates![2]! + writes * rates![3]!) / 1_000_000 : null;
      responses.push({ ...request, responseId: body.response?.id, responseModel: body.response?.model, responseServiceTier: body.response?.service_tier, usage, apiEquivalentUsd: estimate });
    }
  }
  const cost = (warmup: boolean) => responses.filter((entry) => entry.warmup === warmup).reduce((total, entry) => total + (entry.apiEquivalentUsd ?? 0), 0);
  const captureStats = existsSync(join(directory, "capture-stats.json")) ? JSON.parse(readFileSync(join(directory, "capture-stats.json"), "utf8")) : undefined;
  return {
    requests, responses, calls, captureStats, malformedRecords,
    truncatedRecords: records.filter((record) => record.truncated).length,
    undecodedWebSocketBodies: records.filter((record) => record.kind === "websocket" && record.body == null).length,
    httpDecodeErrors: records.filter((record) => ["request_body", "response_body"].includes(record.kind) && record.decode_error).length,
    apiEquivalentUsd: { generation: cost(false), warmup: cost(true), total: cost(false) + cost(true) },
    unknownPriceResponses: responses.filter((response) => response.apiEquivalentUsd === null).length,
    unmatchedRequests: [...pending.values()].reduce((total, queue) => total + queue.length, 0) + [...responseRequests.keys()].filter((id) => !completedIds.has(id)).length,
    counts: Object.fromEntries([...new Set(records.map((record) => String(record.kind)))].map((kind) => [kind, records.filter((record) => record.kind === kind).length])),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? ".");
  const result = analyze(directory);
  writeFileSync(join(directory, "analysis.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ directory, requests: result.requests.length, responses: result.responses.length, apiEquivalentUsd: result.apiEquivalentUsd, captureStats: result.captureStats }));
}

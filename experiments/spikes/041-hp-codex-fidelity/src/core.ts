/** Portable consumer code. The host supplies the actual aiui-prompts implementation. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export interface TextInput {
  text: string;
  origin: JsonObject;
  label?: string;
  spans?: readonly { start: number; end: number; origin: JsonObject; label?: string }[];
}
/** Minimal structural boundary; these functions are loaded from the real package, never emulated. */
export interface PromptsApi {
  importText(input: TextInput): unknown;
  snapshot(node: unknown): SemanticRecord;
  serializeRecord(record: SemanticRecord): string;
  parseRecord(value: string): SemanticRecord;
  rehydrate(record: SemanticRecord): Compiled;
  consumerOperation(input: {
    adapter: AdapterIdentity;
    action: string;
    bindings: { key: string; content: SemanticRecord }[];
    params: JsonObject;
  }): Operation;
  lowerOperation(operation: Operation, target: Target, assets: JsonObject, adapters: Adapter[]): Prepared;
  captureWire(prepared: Prepared, payload: Json, metadata: { capturedAt: string; transportId?: string }): Wire;
  verifyWire(operation: Operation, wire: Wire, adapters: Adapter[]): { equal: boolean };
  serializeOperation(operation: Operation): string;
  parseOperation(value: string): Operation;
  serializeWire(wire: Wire): string;
  parseWire(value: string): Wire;
}
/** One checked injection boundary for source-loading Node and package-importing browser hosts. */
export function bindPrompts(content: object, operations: object): PromptsApi {
  const api = { ...content, ...operations } as Record<string, unknown>;
  for (const name of ["importText", "snapshot", "serializeRecord", "parseRecord", "rehydrate", "consumerOperation", "lowerOperation", "captureWire", "verifyWire", "serializeOperation", "parseOperation", "serializeWire", "parseWire"]) {
    if (typeof api[name] !== "function") throw new Error(`Prompts API missing: ${name}`);
  }
  return api as unknown as PromptsApi;
}
export interface SemanticRecord { readonly fingerprint: string }
export interface Compiled { readonly parts: readonly { type: string; id: string; text?: string }[] }
export interface Operation {
  readonly records: Readonly<Record<string, SemanticRecord>>;
  readonly operation: { readonly params: JsonObject };
}
export interface Prepared { readonly payload: Json; readonly status: string; readonly mappings: readonly Mapping[] }
export interface Wire { readonly payload: Json }
interface AdapterIdentity { readonly name: string; readonly version: string }
interface Target { kind: "custom"; adapter: AdapterIdentity; options: JsonObject }
interface Mapping {
  path: (string | number)[];
  binding: string;
  record: string;
  part: string;
  start: number;
  end: number;
  relation: "copy";
}
export interface Adapter {
  identity: AdapterIdentity;
  capabilities: { actions: string[]; content: string[]; assets: string[] };
  lower(input: {
    operation: { action: string; params: JsonObject };
    bindings: readonly { key: string; record: string; compiled: Compiled }[];
  }): { payload: Json; mappings: Mapping[]; decisions: JsonObject[] };
}
export const adapterIdentity = { name: "hp-codex/response-create", version: "0.1.0-spike" } as const;
const reserved = new Set(["type", "model", "instructions", "input", "tools"]);
/** Keep freeform/namespace/hosted tool declarations as native JSON, without JSON-function projection. */
export function createFidelityAdapter(): Adapter {
  return {
    identity: adapterIdentity,
    capabilities: { actions: ["response.create"], content: ["text"], assets: [] },
    lower({ operation, bindings }) {
      if (operation.action !== "response.create") throw new Error("Unsupported fidelity action");
      const fields = operation.params.fields as JsonObject;
      for (const key of Object.keys(fields)) {
        if (reserved.has(key)) throw new Error(`Reserved response field: ${key}`);
      }
      const payload: JsonObject = {
        ...fields,
        type: "response.create",
        model: operation.params.model!,
        input: operation.params.input!,
      };
      const lite = operation.params.layout === "codex-lite";
      const prefix: Json[] = [];
      if (lite) {
        const tools = operation.params.tools as Json[];
        if (tools.length) prefix.push({ type: "additional_tools", role: "developer", tools: liteTools(tools) });
      } else payload.tools = operation.params.tools!;
      const mappings: Mapping[] = [];
      for (const binding of bindings) {
        if (binding.key !== "instructions") throw new Error(`Unsupported binding: ${binding.key}`);
        let text = "";
        for (const part of binding.compiled.parts) {
          if (part.type !== "text" || typeof part.text !== "string") throw new Error("Text-only instructions");
          mappings.push({
            path: lite ? ["input", prefix.length, "content", 0, "text"] : ["instructions"], binding: binding.key, record: binding.record,
            part: part.id, start: text.length, end: text.length + part.text.length, relation: "copy",
          });
          text += part.text;
        }
        if (lite) prefix.push({ type: "message", role: "developer", content: [{ type: "input_text", text }] });
        else payload.instructions = text;
      }
      if (lite) payload.input = [...prefix, ...(operation.params.input as Json[])];
      return {
        payload, mappings,
        decisions: [{ kind: "native-json-pass-through", fields: ["input", "tools"], adapter: adapterIdentity.name }],
      };
    },
  };
}
export interface RequestInput {
  instructions: TextInput;
  model: string;
  input: Json[];
  tools: Json[];
  fields?: JsonObject;
  /** Native GPT-6 prefix placement by default; generic Responses remains an explicit comparison. */
  layout?: "codex-lite" | "responses";
}
/** Import the upstream renderer's bytes, retain semantic ownership, then record the operation. */
export function recordRequest(prompts: PromptsApi, request: RequestInput): Operation {
  const record = prompts.snapshot(prompts.importText(request.instructions));
  return prompts.consumerOperation({
    adapter: adapterIdentity,
    action: "response.create",
    bindings: [{ key: "instructions", content: record }],
    params: { model: request.model, input: request.input, tools: request.tools, fields: request.fields ?? {}, layout: request.layout ?? "codex-lite" },
  });
}
/** Port of ToolSpec::create_tools_json_for_responses_lite grouping, without changing schemas. */
export function liteTools(tools: readonly Json[]): Json[] {
  const result: Json[] = [];
  const functions: JsonObject = { type: "namespace", name: "functions", description: "", tools: [] };
  let position: number | undefined;
  for (const value of tools) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool must be an object");
    if (value.type === "function" || value.type === "custom") (functions.tools as Json[]).push(value);
    else if (value.type === "namespace" && value.name === "functions") {
      if (typeof value.description === "string" && value.description.trim()) functions.description = value.description;
      if (!Array.isArray(value.tools)) throw new Error("Namespace tools must be an array");
      (functions.tools as Json[]).push(...value.tools);
    } else { result.push(value); continue; }
    position ??= result.length;
  }
  if (position !== undefined && (functions.tools as Json[]).length) result.splice(position, 0, functions);
  return result;
}
export function prepareRequest(prompts: PromptsApi, operation: Operation): Prepared {
  return prompts.lowerOperation(operation, { kind: "custom", adapter: adapterIdentity, options: {} }, {}, [createFidelityAdapter()]);
}

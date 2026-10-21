import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createFidelityAdapter, liteTools, prepareRequest, recordRequest, type JsonObject } from "./core.ts";
import { defaultCodexCheckout, loadNativeInputs, loadPrompts } from "./local.ts";

const { prompts } = await loadPrompts();
const native = await loadNativeInputs();
const capturedAt = "2026-10-18T00:00:00Z";

test("real toolkit imports exact upstream text and preserves semantic replay", () => {
  const original = native.instructions.text;
  const record = prompts.snapshot(prompts.importText(native.instructions));
  const replayed = prompts.rehydrate(prompts.parseRecord(prompts.serializeRecord(record)));
  assert.equal(replayed.parts.map((part) => part.text).join(""), original);
  assert.ok(original.length > 10000, "using upstream model text rather than a tiny fixture");
  assert.match(prompts.serializeRecord(record), /instructions_template/);
});

test("exact whitespace and Unicode span ownership survive to mapped wire text", () => {
  const text = "first\r\n  🧪 x²\n";
  const operation = recordRequest(prompts, {
    instructions: { text, origin: { source: "fixture" }, spans: [{ start: 9, end: 11, origin: { source: "emoji" } }] },
    model: "gpt-6-luna", input: [], tools: [], layout: "responses",
  });
  const prepared = prepareRequest(prompts, operation);
  assert.equal((prepared.payload as JsonObject).instructions, text);
  // The compiler coalesces text parts; semantic source owners remain in the record.
  assert.ok(prepared.mappings.length >= 1);
  assert.match(prompts.serializeOperation(operation), /emoji/);
  const restored = prompts.parseOperation(prompts.serializeOperation(operation));
  const wire = prompts.captureWire(prepared, JSON.parse(JSON.stringify(prepared.payload)), { capturedAt });
  assert.equal(prompts.verifyWire(restored, prompts.parseWire(prompts.serializeWire(wire)), [createFidelityAdapter()]).equal, true);
  const changed = prompts.captureWire(prepared, { ...(prepared.payload as JsonObject), instructions: text.trim() }, { capturedAt });
  assert.equal(prompts.verifyWire(restored, changed, [createFidelityAdapter()]).equal, false);
});

test("freeform grammar stays native and full provider items remain unchanged", async () => {
  const grammar = await readFile(resolve(process.env.CODEX_SOURCE_CHECKOUT ?? defaultCodexCheckout, "codex-rs/core/assets/tools/apply_patch.lark"), "utf8");
  const tool = native.tools[0] as JsonObject;
  assert.equal(tool.type, "custom");
  assert.equal((tool.format as JsonObject).definition, grammar);
  const input = [
    { type: "reasoning", id: "reasoning_fixture", encrypted_content: "synthetic-encrypted-state", summary: [] },
    { type: "custom_tool_call", call_id: "call_fixture", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
    { type: "custom_tool_call_output", call_id: "call_fixture", output: "local fixture result" },
  ];
  const operation = recordRequest(prompts, { ...native, model: "gpt-6-luna", input, layout: "responses" });
  const payload = prepareRequest(prompts, operation).payload as JsonObject;
  assert.deepEqual(payload.input, input);
  assert.deepEqual(payload.tools, native.tools);
  assert.equal(payload.instructions, native.instructions.text);
  input[0]!.encrypted_content = "caller mutation";
  assert.equal(((payload.input as JsonObject[])[0]!).encrypted_content, "synthetic-encrypted-state");
});

test("native-lite comparison keeps role and prefix ordering; it is offline only", () => {
  const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "fixture" }] }];
  const operation = recordRequest(prompts, { ...native, model: "gpt-6-luna", input });
  const prepared = prepareRequest(prompts, operation);
  const payload = prepared.payload as JsonObject;
  assert.equal(payload.instructions, undefined);
  assert.equal(payload.tools, undefined);
  const items = payload.input as JsonObject[];
  assert.equal(items[0]!.type, "additional_tools");
  assert.equal(items[0]!.role, "developer");
  assert.equal(items[1]!.role, "developer");
  assert.equal(((items[1]!.content as JsonObject[])[0]!).text, native.instructions.text);
  assert.deepEqual(items[2], input[0]);
  assert.deepEqual(prepared.mappings[0]!.path, ["input", 1, "content", 0, "text"]);
  const wire = prompts.captureWire(prepared, prepared.payload, { capturedAt });
  assert.equal(prompts.verifyWire(operation, wire, [createFidelityAdapter()]).equal, true);
});

test("lite grouping preserves hosted ordering and explicit functions namespace descriptions", () => {
  const functionTool = { type: "function", name: "fixture", strict: false, parameters: { type: "object" } };
  const hosted = { type: "web_search", external_web_access: true };
  assert.deepEqual(liteTools([hosted, functionTool, { type: "namespace", name: "functions", description: "native description", tools: native.tools }]), [
    hosted, { type: "namespace", name: "functions", description: "native description", tools: [functionTool, ...native.tools] },
  ]);
});

test("adapter replay refuses missing versions and catches tool-schema drift", () => {
  const operation = recordRequest(prompts, { ...native, model: "gpt-6-luna", input: [], layout: "responses" });
  const prepared = prepareRequest(prompts, operation);
  const wire = prompts.captureWire(prepared, { ...(prepared.payload as JsonObject), tools: [] }, { capturedAt });
  assert.equal(prompts.verifyWire(operation, wire, [createFidelityAdapter()]).equal, false);
  assert.throws(() => prompts.verifyWire(operation, wire, [{ ...createFidelityAdapter(), identity: { name: "hp-codex/response-create", version: "wrong" } }]));
  const collision = recordRequest(prompts, { ...native, model: "gpt-6-luna", input: [], fields: { model: "other" } });
  assert.throws(() => prepareRequest(prompts, collision), /Reserved response field/);
});

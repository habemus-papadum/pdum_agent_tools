import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createFidelityAdapter, prepareRequest, recordRequest, type JsonObject } from "./core.ts";
import { browserProof } from "./browser-build.ts";
import { inventoryNativeSources, loadNativeInputs, loadPrompts } from "./local.ts";

const { prompts, provenance: aiui } = await loadPrompts();
const native = await loadNativeInputs(process.env.FIDELITY_MODEL ?? "gpt-6-luna");
const digest = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const directory = fileURLToPath(new URL("../../../artifacts/041-hp-codex-fidelity/", import.meta.url));
await mkdir(directory, { recursive: true });
const browser = await browserProof(aiui.root, `${directory}/browser-proof.mjs`);
const sourceInventory = await inventoryNativeSources();
await writeFile(`${directory}/source-inventory.json`, JSON.stringify(sourceInventory, null, 2));
const results = [];
for (const layout of ["codex-lite", "responses"] as const) {
  const operation = recordRequest(prompts, {
    instructions: native.instructions, tools: native.tools, model: String(native.selection.slug), layout,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Offline fidelity specimen; do not send." }] }],
    fields: { store: false, stream: true, include: ["reasoning.encrypted_content"], tool_choice: "auto", parallel_tool_calls: false, reasoning: { effort: "low", context: "all_turns" } },
  });
  const restored = prompts.parseOperation(prompts.serializeOperation(operation));
  const prepared = prepareRequest(prompts, restored);
  // In this offline probe the boundary is local JSON serialization, not an upstream send.
  const serialized = JSON.stringify(prepared.payload);
  const captured = prompts.captureWire(prepared, JSON.parse(serialized), { capturedAt: new Date().toISOString(), transportId: "offline-json-boundary" });
  const verified = prompts.verifyWire(restored, captured, [createFidelityAdapter()]);
  assert.equal(verified.equal, true);
  const payload = prepared.payload as JsonObject;
  const input = payload.input as JsonObject[];
  const topology = {
    topLevelFields: Object.keys(payload),
    inputRoles: input.map((item) => ({ type: item.type, role: item.role ?? null })),
    instructionLocation: layout === "responses" ? "instructions" : "input[1].content[0].text",
    toolLocation: layout === "responses" ? "tools" : "input[0].tools[0].tools",
  };
  await writeFile(`${directory}/${layout}.operation.json`, prompts.serializeOperation(operation));
  await writeFile(`${directory}/${layout}.wire.json`, prompts.serializeWire(captured));
  results.push({ layout, verified: verified.equal, status: prepared.status, topology,
    topologySha256: digest(topology), frameSha256: digest(serialized), mappings: prepared.mappings.length });
}
const result = {
  observedAt: new Date().toISOString(), node: process.version, codex: native.provenance, aiui,
  model: native.selection, instructions: { utf16: native.instructions.text.length, sha256: digest(native.instructions.text), origin: native.instructions.origin },
  tools: { count: native.tools.length, sha256: digest(native.tools), sources: native.toolSources },
  compact: { promptSha256: digest(native.compact), prefixSha256: digest(native.summaryPrefix) },
  results, browser, sourceInventoryEntries: sourceInventory.length, providerRequests: 0, estimatedCostUsd: 0,
  limits: ["No native process request comparison", "No provider requests", "No generated UUID metadata", "No complete world-state renderer or code-mode registry"],
};
await writeFile(`${directory}/summary.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

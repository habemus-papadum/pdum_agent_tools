import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyze } from "./analyze.js";
import { verify } from "./verify.js";

test("correlates IDs, deduplicates completion, and prices cache writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "spike-010-analysis-"));
  try {
    const completed = { kind: "websocket", flow_id: "flow", body: { type: "response.completed", response: { id: "response", model: "gpt-6-sol", service_tier: "default", usage: { input_tokens: 13, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 }, output_tokens: 5 } } } };
    const rows = [
      { kind: "request", flow_id: "flow", headers: { "thread-id": "child", "x-codex-parent-thread-id": "parent" } },
      { kind: "websocket", flow_id: "flow", from_client: true, body: { type: "response.create", model: "gpt-6-sol", reasoning: { effort: "low" } } },
      { kind: "websocket", flow_id: "flow", body: { type: "response.created", response: { id: "response" } } },
      completed, completed,
    ];
    writeFileSync(join(directory, "level2.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const result = analyze(directory);
    assert.equal(result.responses.length, 1);
    assert.equal(result.responses[0].threadId, "child");
    assert.equal(result.unmatchedRequests, 0);
    assert.equal(result.malformedRecords, 0);
    assert(Math.abs(result.apiEquivalentUsd.generation - 0.0000739) < 1e-12);
    completed.body.response.model = "gpt-6-luna";
    writeFileSync(join(directory, "level2.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\nnot-json\n");
    const invalid = analyze(directory);
    assert.equal(invalid.unknownPriceResponses, 1);
    assert.equal(invalid.malformedRecords, 1);
  } finally { rmSync(directory, { recursive: true }); }
});

test("rejects undecoded WebSocket and HTTP bodies even without truncation", () => {
  const directory = mkdtempSync(join(tmpdir(), "spike-010-decode-"));
  try {
    writeFileSync(join(directory, "capture-stats.json"), JSON.stringify({ events_dropped: 0 }));
    const rows = [
      { kind: "websocket", flow_id: "flow", body: null, truncated: false },
      { kind: "response_body", flow_id: "flow", body: null, truncated: false, decode_error: "non-JSON or unsupported encoding; body omitted" },
    ];
    writeFileSync(join(directory, "level2.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const result = analyze(directory);
    assert.equal(result.truncatedRecords, 0);
    assert.equal(result.malformedRecords, 0);
    assert.equal(result.undecodedWebSocketBodies, 1);
    assert.equal(result.httpDecodeErrors, 1);
    for (const row of rows) {
      writeFileSync(join(directory, "level2.jsonl"), JSON.stringify(row) + "\n");
      assert.throws(() => verify(directory, {}), (error: unknown) => error instanceof assert.AssertionError && error.actual === 1 && error.expected === 0);
    }
  } finally { rmSync(directory, { recursive: true }); }
});

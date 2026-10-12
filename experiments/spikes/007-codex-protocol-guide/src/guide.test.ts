import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { matchesMessageQuery, messagePurpose, type MessageSummary } from "../../../apps/web/src/protocol-content.js";

type Entry = MessageSummary & { kind: string; gate: string };
const document = JSON.parse(readFileSync(new URL("../../../apps/web/public/protocol-inventory.json", import.meta.url), "utf8")) as {
  inventory: Entry[];
  counts: Record<string, { stable: number; full: number }>;
};

test("each schema message has a distinct identity and a method-specific explanation", () => {
  assert.equal(new Set(document.inventory.map((entry) => `${entry.kind}:${entry.method}`)).size, document.inventory.length);
  for (const entry of document.inventory) assert.ok(messagePurpose(entry).length > 15, entry.method);
  for (const [kind, counts] of Object.entries(document.counts)) {
    assert.equal(document.inventory.filter((entry) => entry.kind === kind).length, counts.full, kind);
    assert.ok(counts.stable <= counts.full, kind);
  }
  assert.throws(() => messagePurpose({ method: "unknown/missing", description: "" }), /Missing method-specific summary/);
});

test("search matches wire names, fields, categories, and editorial explanations", () => {
  const steer = document.inventory.find((entry) => entry.method === "turn/steer");
  assert.ok(steer);
  for (const query of [" TURN/STEER ", "expectedTurnId", "Turns & items", "in-flight"]) assert.ok(matchesMessageQuery(steer, query), query);
  assert.equal(matchesMessageQuery(steer, "not-a-real-protocol-query"), false);
  assert.ok(document.inventory.every((entry) => matchesMessageQuery(entry, "")));
});

test("lifecycle policy fields preserve their distinct wire names", () => {
  const start = document.inventory.find((entry) => entry.method === "thread/start");
  const turn = document.inventory.find((entry) => entry.method === "turn/start");
  assert.ok(start?.fields.some((field) => field.name === "sandbox"));
  assert.ok(turn?.fields.some((field) => field.name === "sandboxPolicy"));
  assert.equal(start?.fields.some((field) => field.name === "sandboxPolicy"), false);
});

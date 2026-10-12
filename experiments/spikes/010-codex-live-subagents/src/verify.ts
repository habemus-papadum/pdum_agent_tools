import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyze, type Data } from "./analyze.js";

export function verify(directory: string, result: Data): Data {
  const analysis = analyze(directory);
  assert.equal(analysis.captureStats?.events_dropped, 0);
  assert.equal(analysis.truncatedRecords, 0);
  assert.equal(analysis.malformedRecords, 0);
  assert.equal(analysis.undecodedWebSocketBodies, 0);
  assert.equal(analysis.httpDecodeErrors, 0);
  assert.equal(analysis.unmatchedRequests, 0);
  assert.equal(analysis.unknownPriceResponses, 0);
  assert.equal(result.sourceAuthUnchanged, true);
  const children = [...new Set<string>(analysis.requests.filter((entry: Data) => entry.parentId === result.parentId).map((entry: Data) => entry.threadId))];
  assert.equal(children.length, 2);
  const expectedChildModel = result.childSelection === "explicit gpt-6-luna" ? "gpt-6-luna" : "gpt-6-sol";
  const spawns = analysis.calls.filter((entry: Data) => entry.threadId === result.parentId && entry.name === "spawn_agent");
  assert.equal(spawns.length, 2);
  for (const spawn of spawns) {
    assert.equal(spawn.arguments.fork_turns, "none");
    assert.equal(spawn.arguments.model, expectedChildModel === "gpt-6-luna" ? "gpt-6-luna" : undefined);
    assert.equal(spawn.arguments.reasoning_effort, expectedChildModel === "gpt-6-luna" ? "low" : undefined);
  }
  const protocol = readFileSync(join(directory, "level1.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Data);
  const hostStarts = protocol.filter((entry) => entry.direction === "client" && ["thread/start", "turn/start", "thread/resume"].includes(entry.message.method));
  assert.equal(hostStarts.filter((entry) => entry.message.method === "thread/start").length, 1);
  assert.equal(hostStarts.filter((entry) => entry.message.method === "turn/start").length, 1);
  assert(!hostStarts.some((entry) => children.includes(entry.message.params.threadId)));
  const answers = [];
  for (const id of [result.parentId, ...children]) {
    const expectedModel = id === result.parentId ? "gpt-6-sol" : expectedChildModel;
    const responses = analysis.responses.filter((entry: Data) => entry.threadId === id);
    assert(responses.some((entry: Data) => !entry.warmup));
    assert(responses.every((entry: Data) => entry.model === expectedModel && entry.responseModel === expectedModel && entry.effort === "low"));
    const history = JSON.parse(readFileSync(join(directory, `history-${id}.json`), "utf8")) as Data;
    assert.equal(history.thread.id, id);
    if (id !== result.parentId) assert.equal(history.thread.parentThreadId, result.parentId);
    assert.equal(history.thread.turns.length, 1);
    assert.equal(history.thread.turns[0].status, "completed");
    assert(protocol.some((entry) => entry.direction === "server" && entry.message.method === "turn/completed" && entry.message.params.threadId === id));
    const texts = history.thread.turns[0].items.filter((item: Data) => item.type === "agentMessage").map((item: Data) => String(item.text));
    if (id !== result.parentId) answers.push(...texts);
    else {
      assert(texts.some((text: string) => text.includes("ARITHMETIC=323") && text.includes("SORT=apple,kiwi,pear")));
      const activity = history.thread.turns[0].items.filter((item: Data) => item.type === "subAgentActivity" && item.model);
      assert.equal(activity.length, 2);
      assert(activity.every((item: Data) => item.model === expectedChildModel));
    }
  }
  assert.deepEqual(answers.sort(), ["ARITHMETIC=323", "SORT=apple,kiwi,pear"]);
  return { passed: true, parentId: result.parentId, children, childModel: expectedChildModel, hostCreatedChildren: false, automaticChildEventsObserved: true, apiEquivalentUsd: analysis.apiEquivalentUsd, recoveredHistory: existsSync(join(directory, "history-recovery.json")) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? ".");
  const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8")) as Data;
  const verification = verify(directory, result);
  writeFileSync(join(directory, "verification.json"), JSON.stringify(verification, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ directory, ...verification }));
}

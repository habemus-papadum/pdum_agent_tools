import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Annotations,
  attachTags,
  defaultTagsPath,
  parseTagArguments,
  tagsOf,
} from "../src/annotations.ts";
import { listSessions, loadSession, renderSession } from "../src/forensics.ts";
import { fixture } from "./fixture.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("annotations", () => {
  it("names the tags file beside the history file", () => {
    expect(defaultTagsPath("/x/codex.duckdb")).toBe("/x/codex.tags.duckdb");
    expect(parseTagArguments(["a=b", "flag", "k=v=w"])).toEqual([
      { key: "a", value: "b" },
      { key: "flag", value: null },
      { key: "k", value: "v=w" },
    ]);
  });

  it("sets, replaces, lists and removes tags, and joins them into sessions", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-history-tags-"));
    dirs.push(dir);
    const tagsPath = path.join(dir, "history.tags.duckdb");
    const store = await Annotations.open(tagsPath);
    await store.set("thread", "t1", "project", "parser", "nehal");
    await store.set("thread", "t1", "project", "parser-v2", "nehal");
    await store.set("thread", "t1", "reviewed", null, "nehal");
    await store.set("turn", "u1", "slow", null, "nehal");
    let tags = await store.list({ kind: "thread", id: "t1" });
    expect(tags.map((t) => [t.key, t.value])).toEqual([
      ["project", "parser-v2"],
      ["reviewed", null],
    ]);
    await store.remove("thread", "t1", "reviewed");
    tags = await store.list();
    expect(tags).toHaveLength(2);
    store.close();

    const db = await fixture();
    try {
      expect(await attachTags(db, path.join(dir, "missing.duckdb"))).toBe(false);
      expect(await attachTags(db, tagsPath)).toBe(true);
      expect(await tagsOf(db, "thread", "t1")).toEqual(["project=parser-v2"]);
      const tagged = await listSessions(db, { tag: { key: "project", value: "parser-v2" } });
      expect(tagged.map((s) => s.threadId)).toEqual(["t1"]);
      const untagged = await listSessions(db, { tag: { key: "project", value: "other" } });
      expect(untagged).toEqual([]);
      const view = await loadSession(db, "t1");
      view.tags = await tagsOf(db, "thread", "t1");
      expect(renderSession(view)).toContain("tags project=parser-v2");
    } finally {
      db.close();
    }
  });
});

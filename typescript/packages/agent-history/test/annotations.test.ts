import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Annotations,
  attachTags,
  defaultTagsPath,
  parseTagArguments,
  TAGS_TABLE,
  tagsDdl,
  tagsLayout,
  tagsOf,
} from "../src/annotations.ts";
import { HistoryDb, isMotherDuck, motherDuckConnectionString } from "../src/db.ts";
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
    expect(tagsLayout("/x/codex.tags.duckdb")).toBe("file");
    expect(parseTagArguments(["a=b", "flag", "k=v=w"])).toEqual([
      { key: "a", value: "b" },
      { key: "flag", value: null },
      { key: "k", value: "v=w" },
    ]);
  });

  it("keeps MotherDuck tags inside the history database", () => {
    expect(isMotherDuck("md:agent_history")).toBe(true);
    expect(isMotherDuck("/x/md:agent_history.duckdb")).toBe(false);
    expect(isMotherDuck(":memory:")).toBe(false);
    expect(defaultTagsPath("md:agent_history")).toBe("md:agent_history");
    expect(tagsLayout("md:agent_history")).toBe("schema");
    expect(motherDuckConnectionString("md:agent_history")).toBe(
      "md:agent_history?attach_mode=single",
    );
    expect(motherDuckConnectionString("md:agent_history?saas_mode=true")).toBe(
      "md:agent_history?saas_mode=true&attach_mode=single",
    );
    expect(motherDuckConnectionString("md:x?attach_mode=workspace")).toBe(
      "md:x?attach_mode=workspace",
    );
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

  it("reads tags from the tagsdb schema of the history database without attaching", async () => {
    const db = await fixture();
    try {
      expect(await attachTags(db, "md:agent_history")).toBe(false);
      await db.run("CREATE SCHEMA tagsdb");
      await db.run(tagsDdl(TAGS_TABLE.schema));
      expect(await attachTags(db, "md:agent_history")).toBe(true);
      expect(await tagsOf(db, "thread", "t1")).toEqual([]);
      await db.run(
        "INSERT INTO tagsdb.tags VALUES ('thread', 't1', 'project', 'parser', 'nehal', now()::timestamp)",
      );
      expect(await tagsOf(db, "thread", "t1")).toEqual(["project=parser"]);
      const tagged = await listSessions(db, { tag: { key: "project", value: null } });
      expect(tagged.map((s) => s.threadId)).toEqual(["t1"]);
    } finally {
      db.close();
    }
  });

  it("writes tags into the tagsdb schema in schema layout", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-history-schema-tags-"));
    dirs.push(dir);
    const historyPath = path.join(dir, "history.duckdb");
    const store = await Annotations.open(historyPath, { layout: "schema" });
    expect(store.table).toBe("tagsdb.tags");
    await store.set("thread", "t1", "project", "parser", "nehal");
    await store.set("thread", "t1", "project", "parser-v2", "nehal");
    await store.set("turn", "u1", "slow", null, "nehal");
    await store.remove("turn", "u1", "slow");
    expect((await store.list()).map((t) => [t.subjectId, t.key, t.value])).toEqual([
      ["t1", "project", "parser-v2"],
    ]);
    store.close();

    // Reopening in schema layout finds the existing table instead of recreating it.
    const again = await Annotations.open(historyPath, { layout: "schema" });
    expect(await again.list({ kind: "thread" })).toHaveLength(1);
    again.close();

    const db = await HistoryDb.open(historyPath);
    try {
      expect(await attachTags(db, "md:history")).toBe(true);
      expect(await tagsOf(db, "thread", "t1")).toEqual(["project=parser-v2"]);
      expect(
        await db.query(
          "SELECT table_name FROM information_schema.tables WHERE table_name = 'tags'",
        ),
      ).toEqual([{ table_name: "tags" }]);
    } finally {
      db.close();
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  blobExcerpt,
  formatDuration,
  formatTokens,
  listSessions,
  loadBlobs,
  loadSession,
  renderSession,
  renderSessionList,
  resolveThread,
} from "../src/forensics.ts";
import { fixture } from "./fixture.ts";

describe("sessions", () => {
  it("lists parent threads with usage, cost and children", async () => {
    const db = await fixture();
    try {
      const sessions = await listSessions(db);
      expect(sessions.map((s) => s.threadId)).toEqual(["t2", "t1"]);
      const [t2, t1] = sessions;
      expect(t1?.turns).toBe(1);
      expect(t1?.responses).toBe(2);
      expect(t1?.totalTokens).toBe(2310);
      expect(t1?.usd).toBeCloseTo(0.0113, 4);
      expect(t1?.children).toBe(1);
      expect(t1?.lineageId).toBe("t1");
      expect(t2?.lineageId).toBe("t1");
      expect(t2?.lineageDepth).toBe(1);
      const all = await listSessions(db, { includeChildren: true });
      expect(all).toHaveLength(3);
      const filtered = await listSessions(db, { like: "parser" });
      expect(filtered.map((s) => s.threadId)).toEqual(["t1"]);
      const lineage = await listSessions(db, { includeChildren: true, lineage: "t1" });
      expect(lineage.map((s) => s.threadId).sort()).toEqual(["t1", "t1:child", "t2"]);
      const text = renderSessionList(sessions);
      expect(text).toContain("Fix the parser");
      expect(text).toContain("2.3k");
      expect(text).toContain("t1+1");
    } finally {
      db.close();
    }
  });

  it("resolves unique prefixes and rejects ambiguous ones", async () => {
    const db = await fixture();
    try {
      expect(await resolveThread(db, "t1")).toBe("t1");
      expect(await resolveThread(db, "t1:ch")).toBe("t1:child");
      await expect(resolveThread(db, "zz")).rejects.toThrow("no thread");
    } finally {
      db.close();
    }
  });
});

describe("show", () => {
  it("renders a session as turns and items with tool excerpts", async () => {
    const db = await fixture();
    try {
      const view = await loadSession(db, "t1");
      expect(view.turns).toHaveLength(1);
      const [turn] = view.turns;
      expect(turn?.items.map((i) => i.label)).toEqual(["user", "bash:rg", "edit", "agent"]);
      expect(turn?.responses).toBe(2);
      expect(turn?.usd).toBeCloseTo(0.0113, 4);
      const blobs = await loadBlobs(db, "t1");
      const text = renderSession(view, { blobs });
      expect(text).toContain(
        "── turn 1  2026-10-01 10:00:00  completed  1m00s  2 resp  2.3k tok  $0.011  gpt-6-astra/xhigh  ttft 3.0s",
      );
      expect(text).toContain("bash:rg");
      expect(text).toContain("a.py +2 -1");
      expect(text).toContain("│ a.py: duckdb");
      expect(text).toContain("compacted");
      expect(text).toContain("sub-agents:");
      const onlyTurn = renderSession(view, { turn: 1, hideThinking: true });
      expect(onlyTurn).not.toContain("sub-agents:");
      expect(text).toContain("continued in t2  2026-10-01 11:00:00  (marker+continued-in)");
      const continued = renderSession(await loadSession(db, "t2"));
      expect(continued).toContain("lineage t1 depth 1");
      expect(continued).toContain(
        "continues t1  (continuation by marker+continued-in, inherited 3 records, fork point 2026-10-01 10:00:50)",
      );
    } finally {
      db.close();
    }
  });

  it("extracts the useful part of a blob", () => {
    expect(blobExcerpt('{"aggregatedOutput":"hello\\n"}')).toBe("hello\n");
    expect(blobExcerpt('{"toolUseResult":{"stdout":"out","stderr":"err"}}')).toBe("out\nerr");
    expect(
      blobExcerpt('{"result":{"content":[{"type":"text","text":"x"},{"type":"image"}]}}'),
    ).toBe("x");
    expect(blobExcerpt("not json")).toBeNull();
    expect(formatDuration(65_000)).toBe("1m05s");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});

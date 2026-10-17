import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHECKS, runChecks } from "../src/checks.ts";
import { QUESTIONS, runQuestions } from "../src/questions.ts";
import { columns, schema } from "../src/schema.ts";
import { fixture } from "./fixture.ts";

describe("schema contract", () => {
  it("is the JSON the Python package exported", () => {
    const raw = JSON.parse(
      readFileSync(new URL("../schema/agent-history.schema.json", import.meta.url), "utf8"),
    );
    expect(schema).toEqual(raw);
    expect(columns("meta")).toEqual(["key", "value"]);
    expect(schema.version).toBeGreaterThanOrEqual(2);
  });

  it("builds every table and view in DuckDB", async () => {
    const db = await fixture();
    try {
      const tables = await db.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables ORDER BY 1",
      );
      const names = new Set(tables.map((t) => t.table_name));
      for (const table of Object.keys(schema.tables)) {
        expect(names.has(table)).toBe(true);
      }
      const rows = await db.query("SELECT basis, count(*) AS n FROM usage_events GROUP BY 1");
      expect(rows).toEqual([{ basis: "usage_record", n: 2n }]);
    } finally {
      db.close();
    }
  });
});

describe("checks and questions", () => {
  it("every check runs and the zero checks pass on a consistent fixture", async () => {
    const db = await fixture();
    try {
      const results = await runChecks(db);
      expect(results).toHaveLength(CHECKS.length);
      for (const result of results) {
        expect(result.error, result.id).toBeUndefined();
        if (result.kind === "zero") {
          expect(result.value, result.id).toBe(0);
        }
      }
    } finally {
      db.close();
    }
  });

  it("flags a schema version mismatch", async () => {
    const db = await fixture();
    try {
      await db.run("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
      const results = await runChecks(db);
      expect(results.find((r) => r.id === "schema-version")?.ok).toBe(false);
    } finally {
      db.close();
    }
  });

  it("every question runs without a SQL error and prices the fixture", async () => {
    const db = await fixture();
    try {
      const results = await runQuestions(db, { term: "duckdb" });
      expect(results).toHaveLength(QUESTIONS.length);
      for (const result of results) {
        expect(result.error, result.id).toBeUndefined();
      }
      const cost = results.find((r) => r.id === "Q1");
      expect(cost?.rows).toBe(1);
      const row = cost?.result[0] as { usd_estimate: number; priced_events: bigint };
      // 400 uncached at 10, 1800 cached at 1, 110 output at 50 per million tokens is USD 0.0113, shown in cents.
      expect(Number(row.usd_estimate)).toBeCloseTo(0.01, 2);
      expect(Number(row.priced_events)).toBe(2);
      const search = results.find((r) => r.id === "Q5");
      expect(search?.result.map((r) => Number(r.matches))).toEqual([2, 1]);
    } finally {
      db.close();
    }
  });
});

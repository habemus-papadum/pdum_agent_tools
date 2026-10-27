import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import {
  estimateResponseCost,
  type PriceSnapshot,
  pricingVersion,
  summarizeResponseCosts,
  type Usage,
} from "../src/analysis.ts";

const zeroUsage: Usage = { uncached: 0, cached: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 };

describe("portable response pricing", () => {
  it("reproduces independently recorded Node/browser totals including cache writes", () => {
    // 070's real-provider ledger: each aggregate includes actual response/compaction usage,
    // excludes inherited fork cost, and was independently checked through production SQL.
    const node = estimateResponseCost({
      model: "gpt-6-luna",
      usage: { uncached: 3_715, cached: 18_183, cacheWrite: 3_954, cacheWrite1h: 0, output: 229 },
    });
    const browser = estimateResponseCost({
      model: "gpt-6-luna",
      usage: { uncached: 48, cached: 25_604, cacheWrite: 140, cacheWrite1h: 0, output: 169 },
    });
    expect(node.status).toBe("priced");
    expect(node.usd).toBeCloseTo(0.00116208, 12);
    expect(browser.usd).toBeCloseTo(0.00036284, 12);
    expect(node.pricingVersion).toBe("litellm 2026-10-17");
  });

  it("retains known subtotal while distinguishing missing, invalid and unpriced records", () => {
    const summary = summarizeResponseCosts([
      { model: "gpt-6-luna", usage: { ...zeroUsage, uncached: 1_000, output: 20 } },
      { model: "unknown-provider-model", usage: zeroUsage },
      { model: "gpt-6-luna", usage: null },
      { model: "gpt-6-luna", usage: { ...zeroUsage, cacheWrite: 3, cacheWrite1h: 4 } },
      { model: "<synthetic>", usage: null },
    ]);
    expect(summary).toEqual({
      pricingVersion,
      knownCostUsd: expect.closeTo(0.00011, 12),
      responses: 5,
      pricedResponses: 1,
      excludedResponses: 1,
      missingUsageResponses: 1,
      invalidUsageResponses: 1,
      unpricedResponses: 1,
      complete: false,
    });
    expect(
      estimateResponseCost({ model: "unknown-provider-model", usage: zeroUsage }).usd,
    ).toBeNull();
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
      expect(
        estimateResponseCost({ model: "gpt-6-luna", usage: { ...zeroUsage, output: value } })
          .status,
      ).toBe("invalid-usage");
    }
  });

  it("uses the supplied dated table and refuses incomplete prices rather than inventing zero", () => {
    const snapshot: PriceSnapshot = {
      source: "test fixture",
      fetched_at: "2026-01-02",
      units: "USD per token",
      entries: {
        incomplete: { input_cost_per_token: 1e-6 },
        priced: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
      },
    };
    expect(estimateResponseCost({ model: "incomplete", usage: zeroUsage }, snapshot).status).toBe(
      "unpriced-model",
    );
    const result = estimateResponseCost(
      { model: "priced", usage: { ...zeroUsage, uncached: 100, output: 50 } },
      snapshot,
    );
    expect(result.usd).toBeCloseTo(0.0002, 12);
    expect(result.pricingVersion).toBe("litellm 2026-01-02");
  });
});

describe("browser build boundary", () => {
  it("builds the public analysis entry without a transitive Node or database dependency", async () => {
    const result = await build({
      root: fileURLToPath(new URL("..", import.meta.url)),
      configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
      logLevel: "silent",
      build: { write: false },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const chunks = new Map(
      outputs
        .flatMap((output) => ("output" in output ? output.output : []))
        .filter((output) => output.type === "chunk")
        .map((output) => [output.fileName, output]),
    );
    expect(chunks.has("analysis.js")).toBe(true);
    const visited = new Set<string>();
    const pending = ["analysis.js"];
    while (pending.length) {
      const name = pending.pop();
      if (!name || visited.has(name)) continue;
      visited.add(name);
      const chunk = chunks.get(name);
      expect(chunk, `Unbundled dependency reachable from /analysis: ${name}`).toBeDefined();
      if (!chunk) throw new Error(`Missing built chunk: ${name}`);
      for (const moduleId of Object.keys(chunk.modules)) {
        expect(moduleId).not.toMatch(
          /node:|@duckdb\/node-api|\/src\/(cli|db|pricing|annotations)\.ts$/,
        );
      }
      for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) {
        pending.push(dependency.replace(/^\.\//, ""));
      }
    }
  });
});

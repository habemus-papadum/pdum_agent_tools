import { describe, expect, it } from "vitest";
import {
  priceSnapshot,
  pricesCte,
  priceUsage,
  pricingVersion,
  ratesFor,
  resolveModel,
  trimTable,
} from "../src/pricing.ts";

describe("pricing", () => {
  it("resolves bare ids, bracketed variants and provider prefixes", () => {
    expect(resolveModel("claude-fable-5-1")?.key).toBe("claude-fable-5-1");
    expect(resolveModel("gpt-6-astra")?.key).toBe("gpt-6-astra");
    expect(resolveModel("<synthetic>")).toBeUndefined();
    expect(resolveModel("no-such-model")).toBeUndefined();
    const table = {
      "anthropic/claude-test": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
    };
    expect(resolveModel("claude-test", table)?.key).toBe("anthropic/claude-test");
    const variants = {
      "claude-x[1m]": { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 },
      "claude-x": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
    };
    expect(resolveModel("claude-x[1m]", variants)?.key).toBe("claude-x[1m]");
    expect(resolveModel("claude-x", variants)?.key).toBe("claude-x");
  });

  it("prices the one-hour cache tier above the five-minute tier", () => {
    const rates = ratesFor("claude-fable-5-1");
    expect(rates).toBeDefined();
    if (!rates) {
      return;
    }
    expect(rates.cacheWrite1h).toBeGreaterThan(rates.cacheWrite);
    expect(rates.cached).toBeLessThan(rates.uncached);
    const flat = priceUsage(rates, {
      uncached: 0,
      cached: 0,
      cacheWrite: 1_000_000,
      cacheWrite1h: 0,
      output: 0,
    });
    const tiered = priceUsage(rates, {
      uncached: 0,
      cached: 0,
      cacheWrite: 1_000_000,
      cacheWrite1h: 1_000_000,
      output: 0,
    });
    expect(flat).toBeCloseTo(rates.cacheWrite, 6);
    expect(tiered).toBeCloseTo(rates.cacheWrite1h, 6);
  });

  it("renders a prices relation and stamps a version", () => {
    const cte = pricesCte();
    expect(cte).toContain("p(model, uncached, cached, cache_write, cache_write_1h, output)");
    expect(cte).toContain("'gpt-6-luna'");
    expect(pricingVersion).toMatch(/^litellm \d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(priceSnapshot.entries).length).toBeGreaterThan(100);
  });

  it("trims a full table to the entries this package prices", () => {
    const trimmed = trimTable(
      {
        sample_spec: { input_cost_per_token: 1 },
        "gpt-6-zeta": {
          input_cost_per_token: 1e-6,
          output_cost_per_token: 2e-6,
          litellm_provider: "openai",
        },
        "gemini-9": { input_cost_per_token: 1e-6 },
        "anthropic/claude-zeta": {
          input_cost_per_token: 3e-6,
          cache_creation_input_token_cost_above_1hr: 6e-6,
        },
        "claude-no-price": { max_input_tokens: 1 },
      },
      "2026-01-01",
    );
    expect(Object.keys(trimmed.entries)).toEqual(["anthropic/claude-zeta", "gpt-6-zeta"]);
    expect(trimmed.entries["gpt-6-zeta"]).toEqual({
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6,
    });
    expect(trimmed.fetched_at).toBe("2026-01-01");
  });
});

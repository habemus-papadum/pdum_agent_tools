import snapshot from "./litellm-snapshot.json" with { type: "json" };

/** One LiteLLM table entry; rates are USD per token. */
export interface LiteLlmEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
  input_cost_per_token_above_200k_tokens?: number;
  input_cost_per_token_above_272k_tokens?: number;
  max_input_tokens?: number;
}

/** The trimmed LiteLLM snapshot shipped with the package. */
export interface PriceSnapshot {
  source: string;
  fetched_at: string;
  units: string;
  entries: Record<string, LiteLlmEntry>;
}

export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export const priceSnapshot = snapshot as PriceSnapshot;

/** Stamp for every priced number: which table, fetched when. */
export const pricingVersion = `litellm ${priceSnapshot.fetched_at}`;

/** Models that never have a price and must not be reported as unpriced drift. */
export const UNPRICED_MODELS = new Set(["<synthetic>"]);

/** USD per million tokens for one model, with the key that actually matched. */
export interface ModelRates {
  model: string;
  pricedAs: string;
  uncached: number;
  cached: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
}

const PREFIXES = ["anthropic/", "openai/", "anthropic.", "us.anthropic.", "global.anthropic."];

/**
 * Resolve a model id to a table entry. Claude ids may carry a bracketed context variant
 * (`claude-opus-4-8[1m]`), tried before the bare id so a long-context call is never priced as
 * standard; provider-prefixed keys are the fallback.
 */
export function resolveModel(
  model: string | null | undefined,
  entries: Record<string, LiteLlmEntry> = priceSnapshot.entries,
): { key: string; entry: LiteLlmEntry } | undefined {
  if (!model || UNPRICED_MODELS.has(model)) {
    return undefined;
  }
  const match = /^(.*?)(?:\[(.+)\])?$/.exec(model);
  const base = match?.[1] ?? model;
  const variant = match?.[2];
  const candidates = variant ? [`${base}[${variant}]`, `${base}-${variant}`, base] : [base];
  for (const candidate of candidates) {
    const entry = entries[candidate];
    if (entry?.input_cost_per_token !== undefined) {
      return { key: candidate, entry };
    }
  }
  for (const prefix of PREFIXES) {
    const entry = entries[prefix + base];
    if (entry?.input_cost_per_token !== undefined) {
      return { key: prefix + base, entry };
    }
  }
  return undefined;
}

/** Per-million rates for a model, or undefined when the table has no entry. */
export function ratesFor(
  model: string | null | undefined,
  entries: Record<string, LiteLlmEntry> = priceSnapshot.entries,
): ModelRates | undefined {
  const hit = resolveModel(model, entries);
  if (!hit || !model) {
    return undefined;
  }
  const e = hit.entry;
  const input = e.input_cost_per_token ?? 0;
  const cacheWrite = e.cache_creation_input_token_cost ?? input;
  return {
    model,
    pricedAs: hit.key,
    uncached: input * 1e6,
    cached: (e.cache_read_input_token_cost ?? input) * 1e6,
    cacheWrite: cacheWrite * 1e6,
    cacheWrite1h: (e.cache_creation_input_token_cost_above_1hr ?? cacheWrite) * 1e6,
    output: (e.output_cost_per_token ?? 0) * 1e6,
  };
}

/** Token counts of one response in the shared schema's terms. */
export interface Usage {
  uncached: number;
  cached: number;
  /** All cache-write tokens, including the one-hour tier. */
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
}

/** USD for one response at the given rates. */
export function priceUsage(rates: ModelRates, usage: Usage): number {
  const fiveMinute = Math.max(usage.cacheWrite - usage.cacheWrite1h, 0);
  return (
    (usage.uncached * rates.uncached +
      usage.cached * rates.cached +
      fiveMinute * rates.cacheWrite +
      usage.cacheWrite1h * rates.cacheWrite1h +
      usage.output * rates.output) /
    1e6
  );
}

/**
 * A `prices(model, uncached, cached, cache_write, cache_write_1h, output)` relation in USD per
 * million tokens, for every bare model id in the snapshot. Rows join on the model id a
 * transcript records; provider-prefixed keys are resolved at query time only through
 * {@link ratesFor}.
 */
export function pricesCte(entries: Record<string, LiteLlmEntry> = priceSnapshot.entries): string {
  const rows: string[] = [];
  for (const key of Object.keys(entries)) {
    if (key.includes("/") || !entries[key]?.input_cost_per_token) {
      continue;
    }
    const rates = ratesFor(key, entries);
    if (!rates) {
      continue;
    }
    rows.push(
      `('${key.replace(/'/g, "''")}', ${rates.uncached}, ${rates.cached}, ${rates.cacheWrite}, ${rates.cacheWrite1h}, ${rates.output})`,
    );
  }
  return `prices AS (SELECT * FROM (VALUES ${rows.join(", ")}) AS p(model, uncached, cached, cache_write, cache_write_1h, output))`;
}

/** The SQL expression pricing one `usage_events` row `u` against a `prices` row `p`. */
export const USD_EXPRESSION = `(greatest(u.input_tokens - COALESCE(u.cached_input_tokens, 0) - COALESCE(u.cache_write_input_tokens, 0), 0) * p.uncached
  + COALESCE(u.cached_input_tokens, 0) * p.cached
  + (COALESCE(u.cache_write_input_tokens, 0) - COALESCE(u.cache_write_1h_input_tokens, 0)) * p.cache_write
  + COALESCE(u.cache_write_1h_input_tokens, 0) * p.cache_write_1h
  + COALESCE(u.output_tokens, 0) * p.output) / 1e6`;

const KEEP = /^(claude-|gpt-|o[134](-|$)|codex|chatgpt|anthropic\.|us\.anthropic\.)/;
const FIELDS: (keyof LiteLlmEntry)[] = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost",
  "cache_creation_input_token_cost_above_1hr",
  "input_cost_per_token_above_200k_tokens",
  "input_cost_per_token_above_272k_tokens",
  "max_input_tokens",
];

/** Trim a full LiteLLM table to the OpenAI and Anthropic entries this package prices. */
export function trimTable(full: Record<string, unknown>, fetchedAt: string): PriceSnapshot {
  const entries: Record<string, LiteLlmEntry> = {};
  for (const key of Object.keys(full).sort()) {
    const raw = full[key];
    if (key === "sample_spec" || !raw || typeof raw !== "object") {
      continue;
    }
    const bare = key.split("/").at(-1) ?? key;
    if (!KEEP.test(bare) && !key.startsWith("anthropic/") && !key.startsWith("openai/")) {
      continue;
    }
    const entry: LiteLlmEntry = {};
    for (const field of FIELDS) {
      const value = (raw as Record<string, unknown>)[field];
      if (typeof value === "number") {
        entry[field] = value;
      }
    }
    if (entry.input_cost_per_token !== undefined) {
      entries[key] = entry;
    }
  }
  return { source: LITELLM_URL, fetched_at: fetchedAt, units: "USD per token", entries };
}

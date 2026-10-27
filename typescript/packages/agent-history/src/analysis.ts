/**
 * Portable pricing over normalized, already-deduplicated response observations.
 * This entry point has no filesystem, database, provider SDK or automatic network access.
 */
export * from "./pricing-core.ts";

import {
  type ModelRates,
  type PriceSnapshot,
  priceSnapshot,
  priceUsage,
  ratesFor,
  resolveModel,
  UNPRICED_MODELS,
  type Usage,
} from "./pricing-core.ts";

export interface ResponseCostInput {
  model: string | null | undefined;
  /** Missing counters are not zero; normalize provider-specific counters before calling. */
  usage: Usage | null | undefined;
}

export type ResponseCostEstimate = {
  model: string | null;
  pricingVersion: string;
} & (
  | { status: "priced"; usd: number; rates: ModelRates }
  | {
      status: "missing-usage" | "invalid-usage" | "unpriced-model" | "excluded";
      usd: null;
    }
);

function validUsage(usage: Usage): boolean {
  return (
    [usage.uncached, usage.cached, usage.cacheWrite, usage.cacheWrite1h, usage.output].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) && usage.cacheWrite1h <= usage.cacheWrite
  );
}

/**
 * Estimate one response using the existing table and cache arithmetic, with explicit coverage.
 * Rates follow the selected model key; this does not infer service/context tiers or invoices.
 */
export function estimateResponseCost(
  input: ResponseCostInput,
  snapshot: PriceSnapshot = priceSnapshot,
): ResponseCostEstimate {
  const identity = {
    model: input.model ?? null,
    pricingVersion: `litellm ${snapshot.fetched_at}`,
  };
  if (input.model && UNPRICED_MODELS.has(input.model)) {
    return { ...identity, status: "excluded", usd: null };
  }
  if (input.usage === null || input.usage === undefined) {
    return { ...identity, status: "missing-usage", usd: null };
  }
  if (!validUsage(input.usage)) {
    return { ...identity, status: "invalid-usage", usd: null };
  }
  const hit = resolveModel(input.model, snapshot.entries);
  const rates = ratesFor(input.model, snapshot.entries);
  if (
    !rates ||
    hit?.entry.output_cost_per_token === undefined ||
    ![rates.uncached, rates.cached, rates.cacheWrite, rates.cacheWrite1h, rates.output].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  ) {
    return { ...identity, status: "unpriced-model", usd: null };
  }
  return { ...identity, status: "priced", usd: priceUsage(rates, input.usage), rates };
}

export interface ResponseCostSummary {
  pricingVersion: string;
  /** Sum of priced records only; not an assertion that all provider work was observed. */
  knownCostUsd: number;
  responses: number;
  pricedResponses: number;
  excludedResponses: number;
  missingUsageResponses: number;
  invalidUsageResponses: number;
  unpricedResponses: number;
  /** Every supplied non-excluded record had valid counters and an available price. */
  complete: boolean;
}

/**
 * Price an already-deduplicated collection. Source/response identity and inherited-fork
 * exclusion remain the caller's responsibility; do not combine duplicate observer feeds here.
 */
export function summarizeResponseCosts(
  inputs: Iterable<ResponseCostInput>,
  snapshot: PriceSnapshot = priceSnapshot,
): ResponseCostSummary {
  const result: ResponseCostSummary = {
    pricingVersion: `litellm ${snapshot.fetched_at}`,
    knownCostUsd: 0,
    responses: 0,
    pricedResponses: 0,
    excludedResponses: 0,
    missingUsageResponses: 0,
    invalidUsageResponses: 0,
    unpricedResponses: 0,
    complete: true,
  };
  for (const input of inputs) {
    const estimate = estimateResponseCost(input, snapshot);
    result.responses++;
    switch (estimate.status) {
      case "priced":
        result.pricedResponses++;
        result.knownCostUsd += estimate.usd;
        break;
      case "excluded":
        result.excludedResponses++;
        break;
      case "missing-usage":
        result.missingUsageResponses++;
        result.complete = false;
        break;
      case "invalid-usage":
        result.invalidUsageResponses++;
        result.complete = false;
        break;
      case "unpriced-model":
        result.unpricedResponses++;
        result.complete = false;
        break;
    }
  }
  return result;
}

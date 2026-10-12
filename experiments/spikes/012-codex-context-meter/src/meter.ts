import assert from "node:assert/strict";

export const baselineTokens = 12_000;

export type TokenSnapshot = {
  last: { totalTokens: number };
  total: { totalTokens: number };
  modelContextWindow: number | null;
};

export function remainingPercent(lastTotalTokens: number, contextWindow: number): number {
  assert(Number.isSafeInteger(lastTotalTokens) && Number.isSafeInteger(contextWindow), "Token counts must be safe integers");
  if (contextWindow <= baselineTokens) return 0;
  const effectiveWindow = contextWindow - baselineTokens;
  const used = Math.max(lastTotalTokens - baselineTokens, 0);
  const remaining = Math.max(effectiveWindow - used, 0);
  return Math.round(Math.min(100, Math.max(0, remaining / effectiveWindow * 100)));
}

export function footerMeter(snapshot: TokenSnapshot): { percent: number | null; fallbackUsedTokens: number | null } {
  if (snapshot.modelContextWindow === null) return { percent: null, fallbackUsedTokens: snapshot.total.totalTokens };
  return { percent: remainingPercent(snapshot.last.totalTokens, snapshot.modelContextWindow), fallbackUsedTokens: null };
}

export function statusLinePercent(snapshot: TokenSnapshot | null, configuredWindow: number | null, pending: boolean): number | null {
  if (pending) return null;
  const window = snapshot?.modelContextWindow ?? configuredWindow;
  if (window === null) return 100;
  return remainingPercent(snapshot?.last.totalTokens ?? 0, window);
}

export function usableWindow(contextWindow: number | null, maximumWindow: number | null, effectivePercent: number): number | null {
  const selectedWindow = contextWindow ?? maximumWindow;
  if (selectedWindow === null) return null;
  assert(Number.isSafeInteger(selectedWindow) && Number.isSafeInteger(effectivePercent));
  assert(Number.isSafeInteger(selectedWindow * effectivePercent), "Model metadata exceeds the analyzer's numeric range");
  return Math.trunc(selectedWindow * effectivePercent / 100);
}

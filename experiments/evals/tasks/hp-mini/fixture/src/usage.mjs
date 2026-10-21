/** Summarize recorded request usage. See the usage-accounting skill for the contract. */
export function summarizeUsage(records) {
  records.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const seen = new Set();
  const sessions = new Map();
  for (const record of records) {
    if (seen.has(record.requestId)) continue;
    seen.add(record.requestId);
    const row = sessions.get(record.sessionId) ?? {
      sessionId: record.sessionId, requests: 0, inputTokens: 0,
      cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0,
    };
    row.requests += 1;
    row.inputTokens += record.inputTokens + record.cachedInputTokens;
    row.cachedInputTokens += record.cachedInputTokens;
    row.uncachedInputTokens += record.inputTokens;
    row.outputTokens += record.outputTokens;
    sessions.set(record.sessionId, row);
  }
  const totals = { requests: 0, inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0 };
  for (const row of sessions.values()) for (const key of Object.keys(totals)) totals[key] += row[key];
  return { sessions: [...sessions.values()], totals };
}

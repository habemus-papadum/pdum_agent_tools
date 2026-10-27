import { writeFile } from "node:fs/promises";
import { LITELLM_URL, type PriceSnapshot, trimTable } from "./pricing-core.ts";

// Compatibility surface for Node/CLI consumers. Browser callers use /analysis.
export * from "./pricing-core.ts";

/** Download the LiteLLM table and rewrite the trimmed snapshot file. */
export async function refreshSnapshot(outPath: string, url = LITELLM_URL): Promise<PriceSnapshot> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  const full = (await response.json()) as Record<string, unknown>;
  const trimmed = trimTable(full, new Date().toISOString().slice(0, 10));
  await writeFile(outPath, `${JSON.stringify(trimmed, null, 1)}\n`);
  return trimmed;
}

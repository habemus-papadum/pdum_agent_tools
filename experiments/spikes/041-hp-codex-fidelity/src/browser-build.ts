import { build } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Bundle the real dependency and consumer with browser resolution; run that exact output locally. */
export async function browserProof(checkout: string, outfile: string) {
  const base = resolve(checkout, "packages/aiui-prompts/src");
  const core = fileURLToPath(new URL("./core.ts", import.meta.url));
  await build({
    stdin: {
      contents: `
import * as content from ${JSON.stringify(resolve(base, "index.ts"))};
import * as operations from ${JSON.stringify(resolve(base, "operations.ts"))};
import {bindPrompts, recordRequest, prepareRequest, createFidelityAdapter} from ${JSON.stringify(core)};
export function runBrowserProof() {
  const api = bindPrompts(content,operations);
  const text = "Browser 🧪\\r\\n  exact text\\n";
  const op = recordRequest(api, {instructions:{text,origin:{source:"browser-proof"}}, model:"gpt-6-luna", input:[], tools:[], layout:"responses"});
  const restored = api.parseOperation(api.serializeOperation(op));
  const prepared = prepareRequest(api,restored);
  const wire = api.captureWire(prepared,JSON.parse(JSON.stringify(prepared.payload)),{capturedAt:"2026-10-18T00:00:00Z"});
  return {equal: api.verifyWire(restored,wire,[createFidelityAdapter()]).equal, textEqual: prepared.payload.instructions===text};
}`,
      loader: "ts",
      resolveDir: base,
    },
    bundle: true, platform: "browser", format: "esm", target: "es2024", outfile, metafile: true,
  });
  const module = await import(pathToFileURL(outfile).href) as { runBrowserProof(): { equal: boolean; textEqual: boolean } };
  const result = module.runBrowserProof();
  if (!result.equal || !result.textEqual) throw new Error("Actual browser-target bundle failed fidelity replay");
  return { ...result, execution: "Node loaded browser-target ESM; no DOM or live browser used" };
}

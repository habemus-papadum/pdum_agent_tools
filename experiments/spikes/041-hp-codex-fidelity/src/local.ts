/** Node-only research inputs. This file reads public source, never agent homes or credentials. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bindPrompts, type Json, type JsonObject, type TextInput } from "./core.ts";

export const codexPin = "6c372fbef45f730b6d8aa727b0ec8332365588db";
export const defaultCodexCheckout = fileURLToPath(new URL("../../../vendor/codex/", import.meta.url));
export const defaultAiuiCheckout = fileURLToPath(new URL("../../../../.dev/aiui/", import.meta.url));
const git = (root: string, args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
export function sourceIdentity(root: string) {
  const changes = git(root, ["status", "--porcelain"]);
  return { root: resolve(root), revision: git(root, ["rev-parse", "HEAD"]), dirty: changes.length > 0, changes };
}
export async function loadPrompts(checkout = process.env.AIUI_PROMPTS_CHECKOUT ?? defaultAiuiCheckout) {
  const root = await realpath(resolve(checkout)).catch((cause: unknown) => {
    throw new Error(`AIUI checkout unavailable at ${checkout}. Run scripts/link-aiui.sh from the repository root or set AIUI_PROMPTS_CHECKOUT.`, { cause });
  });
  const base = resolve(root, "packages/aiui-prompts");
  const manifest = JSON.parse(await readFile(resolve(base, "package.json"), "utf8")) as { name: string; version: string };
  if (manifest.name !== "@habemus-papadum/aiui-prompts") throw new Error("Unexpected local prompts package");
  const [core, operations] = await Promise.all([
    import(pathToFileURL(resolve(base, "src/index.ts")).href),
    import(pathToFileURL(resolve(base, "src/operations.ts")).href),
  ]);
  const prompts = bindPrompts(core, operations);
  return { prompts, provenance: { ...sourceIdentity(root), package: manifest.name, version: manifest.version,
    packageChanges: git(root, ["status", "--porcelain", "--", "packages/aiui-prompts"]) } };
}
/** Source evidence manifest, with hashes instead of copied upstream prompt bodies. */
export async function inventoryNativeSources(checkout = process.env.CODEX_SOURCE_CHECKOUT ?? defaultCodexCheckout) {
  const sources = [
    ["model messages and sparse overrides", "codex-rs/prompts/src/model_messages.rs"],
    ["literal model base text", "codex-rs/prompts/src/model_instructions.rs"],
    ["context assembly and diffs", "codex-rs/core/src/session/world_state.rs"],
    ["AGENTS instructions updates", "codex-rs/core/src/context/world_state/agents_md.rs"],
    ["skills catalogs and changes", "codex-rs/ext/skills/src/world_state.rs"],
    ["effective tool visibility", "codex-rs/core/src/tools/spec_plan.rs"],
    ["native tool serialization", "codex-rs/tools/src/tool_spec.rs"],
    ["shell tool declarations", "codex-rs/core/src/tools/handlers/shell_spec.rs"],
    ["freeform patch declaration", "codex-rs/core/src/tools/handlers/apply_patch_spec.rs"],
    ["MCP resource declarations", "codex-rs/core/src/tools/handlers/mcp_resource_spec.rs"],
    ["multi-agent declarations", "codex-rs/core/src/tools/handlers/multi_agents_spec.rs"],
    ["code mode grammar", "codex-rs/core/src/tools/code_mode/execute_spec.rs"],
    ["ordinary turn loop", "codex-rs/core/src/session/turn.rs"],
    ["steering acceptance", "codex-rs/core/src/session/turn_input.rs"],
    ["steering queue", "codex-rs/core/src/session/input_queue.rs"],
    ["request construction", "codex-rs/core/src/client.rs"],
    ["WebSocket frame", "codex-rs/codex-api/src/common.rs"],
    ["local summarizing compaction", "codex-rs/core/src/compact.rs"],
    ["remote v2 compaction", "codex-rs/core/src/compact_remote_v2.rs"],
    ["history and context window", "codex-rs/core/src/context_manager/history.rs"],
    ["subagent lifecycle and messages", "codex-rs/core/src/agent/control.rs"],
    ["subagent forks", "codex-rs/core/src/agent/control/spawn.rs"],
    ["subagent config inheritance", "codex-rs/core/src/agent/child_config.rs"],
  ];
  return Promise.all(sources.map(async ([purpose, path]) => {
    const bytes = await readFile(resolve(checkout, path!));
    return { purpose, path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
}
const modelPath = "codex-rs/models-manager/models.json";
/** Extract literal captured model messages as native Rust render_model_instructions does. */
export async function loadNativeInputs(model = "gpt-6-luna", checkout = process.env.CODEX_SOURCE_CHECKOUT ?? defaultCodexCheckout) {
  const provenance = sourceIdentity(checkout);
  if (provenance.revision !== codexPin) throw new Error(`Expected Codex ${codexPin}; found ${provenance.revision}`);
  const catalog = JSON.parse(await readFile(resolve(checkout, modelPath), "utf8")) as { models: JsonObject[] };
  const selected = catalog.models.find((entry) => entry.slug === model);
  if (!selected) throw new Error(`Model not present in pinned catalog: ${model}`);
  const messages = selected.model_messages as JsonObject | undefined;
  const text = messages?.instructions_template;
  if (typeof text !== "string") throw new Error(`No literal model_messages.instructions_template for ${model}`);
  const grammarPath = "codex-rs/core/assets/tools/apply_patch.lark";
  const specPath = "codex-rs/core/src/tools/handlers/apply_patch_spec.rs";
  const [grammar, spec, compact, summaryPrefix] = await Promise.all([
    readFile(resolve(checkout, grammarPath), "utf8"), readFile(resolve(checkout, specPath), "utf8"),
    readFile(resolve(checkout, "codex-rs/prompts/templates/compact/prompt.md"), "utf8"),
    readFile(resolve(checkout, "codex-rs/prompts/templates/compact/summary_prefix.md"), "utf8"),
  ]);
  const descriptionLiteral = spec.match(/description: ("(?:[^"\\]|\\.)*")\.to_string\(\)/)?.[1];
  if (!descriptionLiteral) throw new Error("Pinned apply_patch constructor changed; inspect before adapting");
  const tool: Json = {
    type: "custom", name: "apply_patch", description: JSON.parse(descriptionLiteral) as string,
    format: { type: "grammar", syntax: "lark", definition: grammar },
  };
  const instructions: TextInput = {
    text,
    origin: { repository: "https://github.com/habemus-papadum/codex", revision: provenance.revision,
      path: modelPath, pointer: `/models/${catalog.models.indexOf(selected)}/model_messages/instructions_template` },
    label: `${model} native model instructions`,
  };
  return {
    instructions, tools: [tool], compact, summaryPrefix, provenance,
    selection: { slug: selected.slug!, tool_mode: selected.tool_mode ?? null, multi_agent_version: selected.multi_agent_version ?? null,
      use_responses_lite: selected.use_responses_lite ?? null, context_window: selected.context_window ?? null },
    toolSources: [specPath, grammarPath],
  };
}

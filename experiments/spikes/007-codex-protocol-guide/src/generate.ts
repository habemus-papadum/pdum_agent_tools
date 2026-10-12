import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Schema = {
  title?: string;
  description?: string;
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, Schema>;
  definitions?: Record<string, Schema>;
  required?: string[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  items?: Schema;
};

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(root, "artifacts/007-codex-protocol-guide");
const binary = realpathSync(process.env.SPIKE_CODEX_BIN ?? join(homedir(), ".local/bin/codex"));
const configDirectory = join(artifacts, "schema-home");
mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
const environment = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? homedir(),
  CODEX_HOME: configDirectory,
};
const version = run(binary, ["--version"]);
const revision = run("git", ["-C", join(root, "vendor/codex"), "rev-parse", "HEAD"]);
for (const surface of ["stable", "experimental"]) {
  run(binary, ["app-server", "generate-json-schema", "--out", join(artifacts, `schema-${surface}`), ...(surface === "experimental" ? ["--experimental"] : [])]);
}
const commonPath = "codex-rs/app-server-protocol/src/protocol/common.rs";
const common = readFileSync(join(root, "vendor/codex", commonPath), "utf8");
const allSchemas = new Map<string, Schema>();
readSchemas(join(artifacts, "schema-experimental"));
const kinds = ["ClientRequest", "ClientNotification", "ServerRequest", "ServerNotification"] as const;
const counts: Record<string, { stable: number; full: number }> = {};
const inventory = kinds.flatMap((kind) => {
  const full = readSchema(join(artifacts, "schema-experimental", `${kind}.json`));
  const stable = readSchema(join(artifacts, "schema-stable", `${kind}.json`));
  assert.ok(full.oneOf && stable.oneOf, `${kind} must contain discriminated variants`);
  counts[kind] = { stable: stable.oneOf.length, full: full.oneOf.length };
  const stableMethods = new Map(stable.oneOf.map((variant) => [methodName(variant), variant]));
  return full.oneOf.map((variant) => {
    const method = methodName(variant);
    const stableVariant = stableMethods.get(method);
    const params = dereference(variant.properties?.params ?? {}, full);
    const stableParams = dereference(stableVariant?.properties?.params ?? {}, stable);
    const sourceOffset = common.indexOf(`=> "${method}"`);
    const sourcePrefixLines: string[] = [];
    if (sourceOffset >= 0) {
      const precedingLines = common.slice(0, common.lastIndexOf("\n", sourceOffset)).split("\n");
      for (const line of precedingLines.reverse()) {
        if (!/^\s*(#\[|\/\/)/.test(line)) break;
        sourcePrefixLines.push(line);
      }
    }
    const sourceTail = sourceOffset < 0 ? "" : common.slice(sourceOffset, common.indexOf("},", sourceOffset) + 2);
    const responseName = kind.endsWith("Request") ? sourceTail.match(/response:\s*(?:v\d::)?(\w+)/)?.[1] ?? null : null;
    const response = responseName ? allSchemas.get(responseName) : undefined;
    const sourceExperimental = sourcePrefixLines.some((line) => /#\[experimental\(/.test(line));
    const fields = Object.entries(params.properties ?? {}).map(([name, schema]) => ({
      name,
      type: describeType(schema),
      required: params.required?.includes(name) ?? false,
      description: schema.description ?? "",
      experimentalOnly: Boolean(stableVariant) && !(name in (stableParams.properties ?? {})),
    }));
    const sourceLine = sourceOffset < 0 ? null : common.slice(0, sourceOffset).split("\n").length;
    return {
      method,
      kind,
      category: category(method, kind),
      description: variant.description?.replace(/^NEW (APIS|NOTIFICATIONS)\s*/i, "") || params.description || "",
      gate: !stableVariant ? "experimental export" : sourceExperimental ? "source experimental" : "stable export",
      paramsType: variant.properties?.params?.$ref?.split("/").at(-1) ?? null,
      fields,
      variants: (params.oneOf ?? params.anyOf ?? []).map((choice) => ({
        type: describeType(choice.properties?.type ?? choice),
        fields: Object.keys(choice.properties ?? {}),
        required: choice.required ?? [],
        description: choice.description ?? "",
      })),
      responseType: response ? responseName : null,
      responseFields: Object.entries(response?.properties ?? {}).map(([name, schema]) => ({ name, type: describeType(schema), required: response?.required?.includes(name) ?? false, description: schema.description ?? "" })),
      sourceUrl: sourceLine ? `https://github.com/openai/codex/blob/${revision}/${commonPath}#L${sourceLine}` : null,
    };
  });
});
assert.equal(new Set(inventory.map((entry) => `${entry.kind}:${entry.method}`)).size, inventory.length);
const output = {
  generatedAt: new Date().toISOString(),
  version,
  sourceRevision: revision,
  binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  sourceNote: "Method inventory and fields come from the installed binary. Source links and source-experimental labels use the separately pinned checkout; release/source drift is possible. Presence in the stable schema does not establish feature availability or a support guarantee.",
  counts,
  inventory,
};
const outputDirectory = join(root, "apps/web/public");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, "protocol-inventory.json"), `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(join(artifacts, "generation.json"), `${JSON.stringify({ ...output, inventory: undefined, binary }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ version, revision, counts, entries: inventory.length, output: "apps/web/public/protocol-inventory.json" }, null, 2));

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: root, env: environment, encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim();
}

function readSchema(path: string): Schema {
  return JSON.parse(readFileSync(path, "utf8")) as Schema;
}

function readSchemas(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) readSchemas(path);
    else if (entry.name.endsWith(".json")) allSchemas.set(entry.name.slice(0, -5), readSchema(path));
  }
}

function dereference(schema: Schema, document: Schema): Schema {
  const name = schema.$ref?.split("/").at(-1);
  return name ? document.definitions?.[name] ?? schema : schema;
}

function methodName(schema: Schema): string {
  const method = schema.properties?.method?.enum?.[0];
  assert.equal(typeof method, "string");
  return method as string;
}

function describeType(schema: Schema): string {
  if (schema.$ref) return schema.$ref.split("/").at(-1) ?? schema.$ref;
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.anyOf ?? schema.oneOf) return (schema.anyOf ?? schema.oneOf ?? []).map(describeType).join(" | ");
  if (schema.type === "array") return `${describeType(schema.items ?? {})}[]`;
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  return schema.type ?? "object";
}

function category(method: string, kind: string): string {
  if (kind === "ServerRequest" || method === "serverRequest/resolved" || method.startsWith("autoApprovalReview/")) return "Approvals & callbacks";
  if (/^thread\/realtime/.test(method)) return "Realtime";
  if (/^thread\/(goal|queue|prediction)/.test(method)) return "Goals & queues";
  if (/^(threadSection|project)\//.test(method) || /^thread\/(attachment|section|metadata)/.test(method)) return "Projects & organization";
  if (/^(turn|item|hook)\//.test(method) || /^thread\/(compact|shellCommand|approveGuardian|backgroundTerminals)/.test(method) || method === "review/start") return "Turns & items";
  if (/^thread\//.test(method)) return "Threads & history";
  if (/^(account|modelProvider\/auth)/.test(method)) return "Account & auth";
  if (/^(mcpServer|mcpServerStatus|app|skills|hooks|marketplace|plugin)\//.test(method) || method === "config/mcpServer/reload") return "Tools & extensions";
  if (/^(command|process|fs|fuzzyFileSearch|environment)(\/|$)/.test(method)) return "Host & filesystem";
  if (/^(model|modelProvider|config|configRequirements|permissionProfile|collaborationMode|experimentalFeature|windowsSandbox|externalAgentConfig)(\/|$)/.test(method)) return "Configuration & discovery";
  if (/^(remoteControl|userVerification)\//.test(method)) return "Remote & verification";
  if (/^(memory|rollout)\//.test(method)) return "Memory & storage";
  return "Connection & diagnostics";
}

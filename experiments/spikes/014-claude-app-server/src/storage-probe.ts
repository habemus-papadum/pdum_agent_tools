import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { runStorageProbe } from "./storage.js";

const root = resolve(import.meta.dirname, "../../../artifacts/014-claude-app-server/storage");
mkdirSync(root, { recursive: true, mode: 0o700 });
const outputDir = mkdtempSync(join(root, "run-"));
const live = process.argv.includes("--live");
const result = await runStorageProbe(outputDir, live ? {
  live: {
    environment: process.env,
    provenance: process.env.CLAUDE_CODE_OAUTH_TOKEN ? "explicit CLAUDE_CODE_OAUTH_TOKEN" : "explicit ANTHROPIC_API_KEY",
  },
} : {});
console.log(JSON.stringify({ ...result, outputDir }, null, 2));

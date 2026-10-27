import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import aiui from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const aiuiRoot = realpathSync(new URL("../../../.dev/aiui", import.meta.url));
const backend = process.env.PDUM_ORCHESTRATOR_URL;

export default defineConfig({
  // Explicit page remounting in main.tsx preserves the durable model owner.
  plugins: [aiui(), solid({ refresh: { disabled: true } })],
  cacheDir: process.env.PDUM_VITE_CACHE ?? "node_modules/.vite",
  resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
  server: {
    host: "0.0.0.0",
    port: 0,
    fs: { allow: [repo, aiuiRoot] },
    ...(backend ? { proxy: { "/api": { target: backend } } } : {}),
  },
});

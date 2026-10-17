import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};

// Node builtins and declared runtime dependencies stay out of the bundle.
const external = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(pkg.dependencies ?? {}),
];

export default defineConfig({
  build: {
    lib: {
      entry: { index: "src/index.ts", cli: "src/cli.ts" },
      formats: ["es"],
      fileName: (_format, entry) => `${entry}.js`,
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep the tsc-emitted .d.ts (build runs tsc first)
    rollupOptions: {
      external: (id) => external.some((mod) => id === mod || id.startsWith(`${mod}/`)),
      output: {
        banner: (chunk: { name: string }) => (chunk.name === "cli" ? "#!/usr/bin/env node" : ""),
      },
    },
  },
});

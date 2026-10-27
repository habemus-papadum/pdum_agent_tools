import { defineConfig } from "vitest/config";

// Every workspace package is a Vitest project with its own vite.config.ts, so
// `vitest run` at the workspace root runs the whole workspace at once.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "tools/dev-instance"],
  },
});

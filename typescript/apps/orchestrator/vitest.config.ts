import { aiui } from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "@solidjs/web" } },
  plugins: [aiui({ locator: true })],
  resolve: {
    conditions: ["browser", "development", "import", "module", "default"],
    dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"],
  },
  test: {
    environment: "jsdom",
    server: { deps: { inline: [/solid-js/, /@solidjs\//, /@habemus-papadum\//] } },
  },
});

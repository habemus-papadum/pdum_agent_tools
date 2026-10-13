import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";

const directory = fileURLToPath(new URL(".", import.meta.url));
await mkdir(resolve(directory, "dist"), { recursive: true });
await build({
  entryPoints: [resolve(directory, "browser-entry.js")],
  outfile: resolve(directory, "dist/browser.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  // The pinned official browser entry still reads these otherwise inert Node
  // fields. No process implementation, credentials, or host paths are exposed.
  banner: { js: "globalThis.process ??= {env:{},argv:[],platform:'browser',cwd:()=> '/',on(){}};" },
});
await copyFile(resolve(directory, "index.html"), resolve(directory, "dist/index.html"));

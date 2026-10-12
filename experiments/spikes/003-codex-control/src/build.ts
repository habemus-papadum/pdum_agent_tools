import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifacts = join(root, "artifacts/003-codex-control");
const source = join(root, "vendor/codex/codex-rs");
await mkdir(artifacts, { recursive: true });
const args = ["build", "--locked", "-p", "codex-cli", "--bin", "codex"];
const readVersion = (command: string, commandArgs: string[]) => {
  const result = spawnSync(command, commandArgs, { cwd: source, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};
const metadata = {
  startedAt: new Date().toISOString(),
  revision: readVersion("git", ["rev-parse", "HEAD"]),
  rustc: readVersion("rustc", ["--version"]),
  cargo: readVersion("cargo", ["--version"]),
  command: ["cargo", ...args],
  cwd: source,
  target: join(artifacts, "target"),
  jobs: process.env.CARGO_BUILD_JOBS ?? "6",
};
await writeFile(join(artifacts, "build-invocation.json"), JSON.stringify(metadata, null, 2));
console.log(`Building ${metadata.revision} with ${metadata.rustc}; log: ${artifacts}/build.log`);
const log = createWriteStream(join(artifacts, "build.log"));
const child = spawn("cargo", args, {
  cwd: source,
  env: { ...process.env, CARGO_TARGET_DIR: metadata.target, CARGO_BUILD_JOBS: metadata.jobs },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
const exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) => resolve(code ?? 1));
});
await new Promise<void>((resolve) => log.end(resolve));
await writeFile(join(artifacts, "build-result.json"), JSON.stringify({ ...metadata, endedAt: new Date().toISOString(), exitCode }, null, 2));
if (exitCode !== 0) throw new Error(`Cargo failed with ${exitCode}; inspect ${artifacts}/build.log`);
console.log(`Built ${join(metadata.target, "debug/codex")}`);

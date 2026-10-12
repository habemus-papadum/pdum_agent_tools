import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = join(root, "vendor/codex");
const output = join(root, "artifacts/013-codex-browser-origin");
const target = join(root, "artifacts/003-codex-control/target");
const baseline = join(target, "debug/codex");
const cargo = process.env.SPIKE_CARGO ?? "/opt/homebrew/bin/cargo";
const rustc = process.env.SPIKE_RUSTC ?? "/opt/homebrew/bin/rustc";
await mkdir(output, { recursive: true, mode: 0o700 });
const environment = { ...process.env, RUSTC: rustc, CARGO_TARGET_DIR: target, CARGO_BUILD_JOBS: "4", CARGO_TERM_COLOR: "never" };
const result = {
  startedAt: new Date().toISOString(),
  sourceRevision: inspect("git", ["-C", source, "rev-parse", "HEAD"]),
  sourceStatus: inspect("git", ["-C", source, "status", "--short"]),
  cargo: inspect(cargo, ["--version"]),
  rustc: inspect(rustc, ["--version"]),
  baselineBinary: baseline,
  baselineSha256Before: await hash(baseline),
  patchSha256: createHash("sha256").update(await readFile(join(root, "spikes/013-codex-browser-origin/browser-origin.patch"))).digest("hex"),
  target,
  commands: [],
};
try {
  result.commands.push(await command("unit-tests", ["test", "--locked", "-p", "codex-app-server-transport", "--lib", "browser_origin", "--", "--nocapture"]));
  assert.equal(result.commands.at(-1).exitCode, 0, "Focused native tests failed");
  result.commands.push(await command("build", ["build", "--locked", "-p", "codex-app-server", "--bin", "codex-app-server"]));
  assert.equal(result.commands.at(-1).exitCode, 0, "Native app-server build failed");
  result.binary = join(output, "codex-app-server");
  await copyFile(join(target, "debug/codex-app-server"), result.binary);
  result.binarySha256 = await hash(result.binary);
} catch (error) {
  result.error = String(error);
  process.exitCode = 1;
} finally {
  result.baselineSha256After = await hash(baseline);
  result.baselineUnchanged = result.baselineSha256After === result.baselineSha256Before;
  result.finishedAt = new Date().toISOString();
  await writeFile(join(output, "build-result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  if (!result.baselineUnchanged) process.exitCode = 1;
}

function inspect(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) throw new Error(`${executable} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function hash(filename) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest("hex");
}

async function command(name, args) {
  const started = Date.now();
  const child = spawn(cargo, args, { cwd: join(source, "codex-rs"), env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  let truncated = false;
  const retain = chunk => {
    log += chunk.toString();
    if (log.length > 8_388_608) { truncated = true; log = log.slice(-8_388_608); }
  };
  child.stdout.on("data", retain);
  child.stderr.on("data", retain);
  const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 480_000);
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  }).finally(() => clearTimeout(timer));
  await writeFile(join(output, `${name}.log`), log, { mode: 0o600 });
  console.log(`${name}: ${status.exitCode}; ${Date.now() - started}ms`);
  return { name, executable: cargo, args, ...status, durationMs: Date.now() - started, truncated };
}

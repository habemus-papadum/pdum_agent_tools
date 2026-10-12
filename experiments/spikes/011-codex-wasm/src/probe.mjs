import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBinding } from "./binding.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sourceRoot = join(root, "vendor/codex");
const workspace = join(sourceRoot, "codex-rs");
const toolchain = process.env.SPIKE_RUST_TOOLCHAIN ?? "1.95.0";
const timeoutMs = 180_000;
const maxLogBytes = 2 * 1024 * 1024;
const artifacts = join(root, "artifacts/011-codex-wasm");
const output = join(artifacts, `run-${Date.now()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const environment = {
  ...process.env,
  CARGO_TARGET_DIR: join(artifacts, "target"),
  CARGO_BUILD_JOBS: "2",
  CARGO_TERM_COLOR: "never",
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
};
delete environment.RUSTFLAGS;
delete environment.RUSTC;
delete environment.RUSTC_WRAPPER;
delete environment.RUSTC_WORKSPACE_WRAPPER;
const result = {
  generatedAt: new Date().toISOString(),
  toolchain,
  host: { platform: platform(), release: release(), arch: arch(), node: process.version },
  targetDirectory: environment.CARGO_TARGET_DIR,
  timeoutMsPerCommand: timeoutMs,
  maxLogBytesPerCommand: maxLogBytes,
  jobs: 2,
  modelCalls: 0,
  checks: [],
};
let originalLock;

try {
  originalLock = await readFile(join(workspace, "Cargo.lock"));
  environment.RUSTC = inspect("rustup", ["which", "--toolchain", toolchain, "rustc"]);
  environment.RUSTDOC = inspect("rustup", ["which", "--toolchain", toolchain, "rustdoc"]);
  Object.assign(result, {
    sourceRevision: inspect("git", ["-C", sourceRoot, "rev-parse", "HEAD"]),
    rustc: inspect("rustup", ["run", toolchain, "rustc", "--version", "--verbose"]),
    cargo: inspect("rustup", ["run", toolchain, "cargo", "--version"]),
    installedTargets: inspect("rustup", ["target", "list", "--installed", "--toolchain", toolchain]),
    compilerPath: environment.RUSTC,
  });
  const requiredTargets = process.argv.includes("--binding-only")
    ? ["wasm32-unknown-unknown"]
    : ["wasm32-unknown-unknown", "wasm32-wasip1"];
  for (const target of requiredTargets) {
    if (!result.installedTargets.split("\n").includes(target)) throw new Error(`Missing target ${target}; install it with rustup target add --toolchain ${toolchain} ${target}`);
  }
  if (!process.argv.includes("--binding-only")) {
    for (const [packageName, target] of [
      ["codex-app-server", "wasm32-unknown-unknown"],
      ["codex-core", "wasm32-unknown-unknown"],
      ["codex-app-server", "wasm32-wasip1"],
    ]) {
      const args = ["run", toolchain, "cargo", "check", "--locked", "--lib", "-p", packageName, "--target", target, "--jobs", "2"];
      result.checks.push(await execute(`${packageName}-${target}`, "rustup", args, workspace));
    }
  }
  const wasm = join(output, "host-websocket.wasm");
  result.bindingCompile = await execute("binding-compile", "rustup", [
    "run", toolchain, "rustc", "--edition", "2024", "--crate-type", "cdylib",
    "--target", "wasm32-unknown-unknown", "-C", "opt-level=s", "-C", "panic=abort",
    join(dirname(fileURLToPath(import.meta.url)), "host-websocket.rs"), "-o", wasm,
  ], root);
  if (result.bindingCompile.exitCode === 0) result.binding = await runBinding(wasm);
} catch (error) {
  result.probeError = String(error);
  process.exitCode = 1;
} finally {
  if (originalLock) {
    try {
      const finalLock = await readFile(join(workspace, "Cargo.lock"));
      result.sourceLockUnchanged = originalLock.equals(finalLock);
      result.lockSha256 = createHash("sha256").update(finalLock).digest("hex");
    } catch (error) {
      result.lockVerificationError = String(error);
    }
  }
  await writeFile(join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ output, ...result }, null, 2));
  if (!result.sourceLockUnchanged || !result.binding?.success || result.probeError) process.exitCode = 1;
}

function inspect(command, args) {
  const inspected = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, env: environment });
  if (inspected.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${inspected.stderr || inspected.error}`);
  return inspected.stdout.trim();
}

async function execute(name, command, args, cwd) {
  console.log(`Checking ${name}`);
  const startedAt = Date.now();
  const invocation = { command, args, cwd };
  const chunks = [];
  let capturedBytes = 0;
  let totalBytes = 0;
  let timedOut = false;
  const child = spawn(command, args, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const retainTail = chunk => {
    chunks.push(chunk);
    capturedBytes += chunk.length;
    totalBytes += chunk.length;
    while (capturedBytes > maxLogBytes) {
      const discarded = Math.min(chunks[0].length, capturedBytes - maxLogBytes);
      if (discarded === chunks[0].length) chunks.shift();
      else chunks[0] = chunks[0].subarray(discarded);
      capturedBytes -= discarded;
    }
  };
  child.stdout.on("data", retainTail);
  child.stderr.on("data", retainTail);
  const timeout = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }, timeoutMs);
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  }).finally(() => clearTimeout(timeout));
  const log = Buffer.concat(chunks).toString("utf8");
  const logPath = join(output, `${name}.log`);
  await writeFile(logPath, log, { mode: 0o600 });
  const diagnostics = log.split("\n").filter(line => /(^error|unsupported|not supported|requires rustc|could not compile)/i.test(line)).slice(0, 16);
  return { name, ...invocation, ...outcome, timedOut, truncated: totalBytes > capturedBytes, totalBytes, capturedBytes, durationMs: Date.now() - startedAt, logPath, diagnostics };
}

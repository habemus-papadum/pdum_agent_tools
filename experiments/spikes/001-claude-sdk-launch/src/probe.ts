import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKUserMessage, SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(spikeRoot, "../..");
const artifactRoot = resolve(repositoryRoot, "artifacts/001-claude-sdk-launch");
mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
const runDirectory = mkdtempSync(join(artifactRoot, "run-"));
const isolatedRoot = mkdtempSync(join(tmpdir(), "agent-spike-001-"));
const configDirectory = join(isolatedRoot, "config");
const workDirectory = join(isolatedRoot, "work");
mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
mkdirSync(join(workDirectory, ".claude"), { recursive: true });
const userStyle = "Explanatory";
const projectStyle = "Learning";
writeJson(join(configDirectory, "settings.json"), { outputStyle: userStyle });
writeJson(join(workDirectory, ".claude/settings.json"), { outputStyle: projectStyle });

const requireFromSpike = createRequire(import.meta.url);
const sdkEntry = requireFromSpike.resolve("@anthropic-ai/claude-agent-sdk");
const sdkRequire = createRequire(sdkEntry);
const sdkManifest = JSON.parse(readFileSync(join(dirname(sdkEntry), "package.json"), "utf8")) as {
  version: string;
  claudeCodeVersion: string;
};
const binaryPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const binaryPath = realpathSync(sdkRequire.resolve(`${binaryPackage}/claude${process.platform === "win32" ? ".exe" : ""}`));
const environment: Record<string, string> = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  CLAUDE_CONFIG_DIR: configDirectory,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  DISABLE_AUTOUPDATER: "1",
  NODE_OPTIONS: "--trace-warnings",
  DEBUG: "spike-sentinel",
};
if (process.env.HOME) environment.HOME = process.env.HOME;
if (process.env.TMPDIR) environment.TMPDIR = process.env.TMPDIR;

const versionResult = spawnSync(binaryPath, ["--version"], {
  cwd: workDirectory,
  env: environment,
  encoding: "utf8",
  timeout: 15_000,
});
assert.equal(versionResult.status, 0, "Bundled executable --version must succeed");
const version = versionResult.stdout.trim();
assert.ok(version.startsWith(sdkManifest.claudeCodeVersion), "Executable and manifest versions must match");
const helpResult = spawnSync(binaryPath, ["--help"], {
  cwd: workDirectory,
  env: environment,
  encoding: "utf8",
  timeout: 15_000,
});
assert.equal(helpResult.status, 0, "Bundled executable --help must succeed");
writeFileSync(join(runDirectory, "cli-help.txt"), helpResult.stdout, { mode: 0o600 });

const metadata = {
  observedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  osRelease: release(),
  node: process.version,
  sdkVersion: sdkManifest.version,
  declaredClaudeCodeVersion: sdkManifest.claudeCodeVersion,
  executableVersion: version,
  sdkEntry,
  sdkSha256: sha256(sdkEntry),
  binaryPackage,
  binaryPath,
  binarySha256: sha256(binaryPath),
  isolatedRoot,
  authenticatedRequestSent: false,
};
writeJson(join(runDirectory, "metadata.json"), metadata);
const source = readFileSync(sdkEntry, "utf8");
const sourceMarkers = [
  { name: "native-binary-resolver", marker: "function xq(", length: 700 },
  { name: "native-or-script-selection", marker: "function cGe(", length: 250 },
  { name: "default-spawn-and-argv", marker: "getDefaultExecutable(){", length: 8_000 },
  { name: "query-environment", marker: "v_=d.pathToClaudeCodeExecutable", length: 2_800 },
  { name: "user-prompt-delivery", marker: "function ST(", length: 450 },
  { name: "keychain-service-name", marker: "function oZ(", length: 750 },
  { name: "keychain-read", marker: "function rWe(", length: 450 },
];
writeJson(join(runDirectory, "source-excerpts.json"), sourceMarkers.map((selection) => {
  const offset = source.indexOf(selection.marker);
  assert.ok(offset >= 0, `Source marker changed: ${selection.name}; review the new SDK version`);
  return {
    name: selection.name,
    marker: selection.marker,
    utf16Offset: offset,
    excerpt: source.slice(offset, offset + selection.length),
  };
}));

const cases: Array<{ name: string; options: Partial<Options>; expectedStyle: string }> = [
  { name: "bundled-isolated", options: { settingSources: [] }, expectedStyle: "default" },
  { name: "explicit-isolated", options: { pathToClaudeCodeExecutable: binaryPath, settingSources: [] }, expectedStyle: "default" },
  { name: "default-settings", options: {}, expectedStyle: projectStyle },
  { name: "user-settings-only", options: { settingSources: ["user"] }, expectedStyle: userStyle },
];
const results = [];
for (const experiment of cases) {
  results.push(await probe(experiment.name, experiment.options, experiment.expectedStyle));
}
writeJson(join(runDirectory, "results.json"), results);
console.log(JSON.stringify({ ...metadata, results, artifacts: runDirectory }, null, 2));

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function probe(name: string, options: Partial<Options>, expectedStyle: string) {
  const experimentDirectory = join(runDirectory, name);
  mkdirSync(experimentDirectory, { mode: 0o700 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let releaseInput: (() => void) | undefined;
  const inputClosed = new Promise<void>((resolveInput) => { releaseInput = resolveInput; });
  async function* noPrompt(): AsyncGenerator<SDKUserMessage> {
    await inputClosed;
  }
  let child: ReturnType<typeof spawn> | undefined;
  let command: string | undefined;
  const outbound: Buffer[] = [];
  const inbound: Buffer[] = [];
  const stderr: Buffer[] = [];
  const started = Date.now();
  const session = query({
    prompt: noPrompt(),
    options: {
      cwd: workDirectory,
      env: environment,
      strictMcpConfig: true,
      persistSession: false,
      permissionMode: "dontAsk",
      tools: [],
      maxTurns: 1,
      maxBudgetUsd: 0.01,
      systemPrompt: "This is an initialization-only probe. No user turn will be sent.",
      extraArgs: { "disable-slash-commands": null },
      ...options,
      abortController: controller,
      spawnClaudeCodeProcess(spawnOptions: SpawnOptions): SpawnedProcess {
        command = realpathSync(spawnOptions.command);
        assert.equal(command, binaryPath, "SDK must launch its workspace binary");
        assert.equal(spawnOptions.env.NODE_OPTIONS, undefined);
        assert.equal(spawnOptions.env.DEBUG, undefined);
        writeJson(join(experimentDirectory, "level0-invocation.json"), {
          command: spawnOptions.command,
          args: spawnOptions.args,
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          signalAborted: spawnOptions.signal.aborted,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
          captureScope: "Explicit credential-free environment and synthetic options only",
        });
        const subprocess = spawn(spawnOptions.command, spawnOptions.args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          signal: spawnOptions.signal,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        child = subprocess;
        const input = new PassThrough();
        input.on("data", (chunk: Buffer) => outbound.push(Buffer.from(chunk)));
        input.pipe(subprocess.stdin);
        subprocess.stdout.on("data", (chunk: Buffer) => inbound.push(Buffer.from(chunk)));
        subprocess.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
        subprocess.stdin.on("error", (error: Error) => input.destroy(error));
        return {
          stdin: input,
          stdout: subprocess.stdout,
          get killed() { return subprocess.killed; },
          get exitCode() { return subprocess.exitCode; },
          get signalCode() { return subprocess.signalCode; },
          kill: subprocess.kill.bind(subprocess),
          on: subprocess.on.bind(subprocess),
          once: subprocess.once.bind(subprocess),
          off: subprocess.off.bind(subprocess),
        };
      },
    },
  });
  try {
    const initialization = await session.initializationResult();
    const payload = initialization as unknown as Record<string, unknown>;
    writeJson(join(experimentDirectory, "level0-initialization.json"), initialization);
    assert.equal(payload.output_style, expectedStyle, "Settings source selection must match the fixture");
    assert.equal(payload.claude_code_version, sdkManifest.claudeCodeVersion);
    assert.equal(initialization.account?.tokenSource, "none", "Isolated probe must not inherit authentication");
    return {
      name,
      initialized: true,
      durationMs: Date.now() - started,
      command,
      outputStyle: payload.output_style,
      expectedStyle,
      executableVersionFromHandshake: payload.claude_code_version,
      tokenSource: initialization.account?.tokenSource,
      settingsAssertionPassed: true,
      noPromptSent: true,
    };
  } finally {
    clearTimeout(timeout);
    releaseInput?.();
    session.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolveExit) => {
        child?.once("exit", () => resolveExit());
        const termination = setTimeout(() => { child?.kill("SIGKILL"); resolveExit(); }, 3_000);
        termination.unref();
      });
    }
    writeFileSync(join(experimentDirectory, "level0-stdin.ndjson"), Buffer.concat(outbound), { mode: 0o600 });
    writeFileSync(join(experimentDirectory, "level0-stdout.ndjson"), Buffer.concat(inbound), { mode: 0o600 });
    writeFileSync(join(experimentDirectory, "stderr.txt"), Buffer.concat(stderr), { mode: 0o600 });
  }
}

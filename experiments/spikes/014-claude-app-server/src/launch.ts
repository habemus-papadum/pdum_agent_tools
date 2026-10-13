import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { query, type Options, type SDKUserMessage, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

export type Frame = Record<string, unknown>;
export interface IsolatedProfile {
  root: string;
  configDirectory: string;
  workDirectory: string;
  environment: Record<string, string>;
  model: string;
}
export interface LaunchRecipe {
  command: string;
  args: string[];
  initialization: Frame;
  environmentKeys: string[];
  sdkVersion: string;
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function resolvePinnedClaude() {
  const require = createRequire(import.meta.url);
  const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
  const sdkDirectory = dirname(sdkEntry);
  const sdkRequire = createRequire(sdkEntry);
  const manifest = JSON.parse(readFileSync(join(sdkDirectory, "package.json"), "utf8")) as {
    version: string; claudeCodeVersion: string;
  };
  assert.equal(manifest.version, "0.3.296", "Review launch mapping on SDK version drift");
  const binaryPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const binaryPath = realpathSync(sdkRequire.resolve(`${binaryPackage}/claude${process.platform === "win32" ? ".exe" : ""}`));
  const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  return {
    sdkEntry, sdkDirectory, sdkVersion: manifest.version, claudeCodeVersion: manifest.claudeCodeVersion,
    binaryPackage, binaryPath, sdkSha256: sha256(sdkEntry), binarySha256: sha256(binaryPath),
    browserSha256: sha256(join(sdkDirectory, "browser-sdk.js")),
  };
}

/** Make an empty HOME/config/workspace. Credentials must be supplied explicitly. */
export function createIsolatedProfile(
  root: string,
  options: { authEnv?: Record<string, string>; model?: string } = {},
): IsolatedProfile {
  root = resolve(root);
  assert(!existsSync(root) || readdirSync(root).length === 0, "Isolated profile root must be new or empty");
  const configDirectory = join(root, "config");
  const workDirectory = join(root, "work");
  for (const directory of [root, configDirectory, workDirectory, join(root, "home"), join(root, "tmp")]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return {
    root, configDirectory, workDirectory, model: options.model ?? "claude-haiku-5-5",
    environment: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
      CLAUDE_CONFIG_DIR: configDirectory, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_AGENT_SDK_VERSION: "0.3.296", CLAUDE_CODE_SDK_READS_SESSION_STATE: "1",
      ANTHROPIC_LOG: "error", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "256", ...options.authEnv,
    },
  };
}

/** Deliberately small launch configuration, validated against the SDK-generated recipe. */
export function workerArgs(profile: IsolatedProfile, options: {
  tools?: string[]; maxTurns?: number; maxBudgetUsd?: number; resume?: string;
  permissionMode?: "default" | "dontAsk" | "bypassPermissions";
  sessionId?: string;
} = {}): string[] {
  return [
    "--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
    `--max-turns=${options.maxTurns ?? 3}`, `--max-budget-usd=${options.maxBudgetUsd ?? 0.1}`,
    `--model=${profile.model}`, "--permission-prompt-tool=stdio",
    `--tools=${(options.tools ?? []).join(",")}`, "--setting-sources=", "--strict-mcp-config",
    `--permission-mode=${options.permissionMode ?? "default"}`, "--include-partial-messages",
    "--disable-slash-commands", ...(options.resume ? [`--resume=${options.resume}`] : []),
    ...(options.sessionId ? [`--session-id=${options.sessionId}`] : []),
  ];
}

export class ClaudeWorker extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  readonly frames: Frame[] = [];
  readonly sent: Frame[] = [];
  private rawOut = "";
  private rawErr = "";
  private pendingLine = "";
  private stopPromise: Promise<void> | undefined;

  constructor(readonly profile: IsolatedProfile, readonly outputDirectory: string, args = workerArgs(profile)) {
    super();
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    const pinned = resolvePinnedClaude();
    this.child = spawn(pinned.binaryPath, args, {
      cwd: profile.workDirectory, env: profile.environment, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    writeJson(join(outputDirectory, "launch.json"), {
      command: pinned.binaryPath, args, cwd: profile.workDirectory,
      environmentKeys: Object.keys(profile.environment).sort(), pid: this.child.pid,
    });
    this.child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      this.rawOut += chunk;
      this.pendingLine += chunk;
      const lines = this.pendingLine.split("\n");
      this.pendingLine = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line) as Frame;
          this.frames.push(frame);
          this.emit("frame", frame);
        } catch (error) { this.emit("parseError", error); }
      }
    });
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => { this.rawErr += chunk; });
    this.child.on("exit", (code, signal) => { this.persist(); this.emit("exit", code, signal); });
    this.child.on("error", (error) => { this.emit("workerError", error); });
    this.child.stdin.on("error", (error) => { this.emit("workerError", error); });
  }

  get alive(): boolean { return this.child.exitCode === null && this.child.signalCode === null; }

  send(frame: Frame): void {
    assert(this.alive, "Cannot send to stopped worker");
    this.sent.push(frame);
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  persist(): void {
    writeFileSync(join(this.outputDirectory, "stdout.ndjson"), this.rawOut, { mode: 0o600 });
    writeFileSync(join(this.outputDirectory, "stdin.ndjson"), this.sent.map((f) => JSON.stringify(f)).join("\n") + "\n", { mode: 0o600 });
    writeFileSync(join(this.outputDirectory, "stderr.txt"), this.rawErr, { mode: 0o600 });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.alive) {
        const exited = new Promise<void>((done) => this.child.once("exit", () => done()));
        this.child.stdin.end();
        await Promise.race([exited, delay(2500)]);
        if (this.alive) this.signalOwnedGroup("SIGTERM");
        await Promise.race([exited, delay(1500)]);
        if (this.alive) { this.signalOwnedGroup("SIGKILL"); await exited; }
      }
      this.persist();
    })();
    return this.stopPromise;
  }

  private signalOwnedGroup(signal: NodeJS.Signals): void {
    if (!this.alive) return;
    if (process.platform !== "win32" && this.child.pid) {
      try { process.kill(-this.child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    } else this.child.kill(signal);
  }
}

export function launchWorker(profile: IsolatedProfile, outputDirectory: string, options: { args?: string[] } = {}): ClaudeWorker {
  return new ClaudeWorker(profile, outputDirectory, options.args ?? workerArgs(profile));
}

/** Credential-free actual SDK launch and initialize; never fabricates a model response. */
export async function captureSdkRecipe(profile: IsolatedProfile, outputDirectory: string): Promise<LaunchRecipe> {
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const pinned = resolvePinnedClaude();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  async function* noInput(): AsyncGenerator<SDKUserMessage> { await gate; }
  let invocation: SpawnOptions | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  const outbound: Buffer[] = [];
  const inbound: Buffer[] = [];
  const errors: Buffer[] = [];
  const options: Options = {
    cwd: profile.workDirectory, env: { ...profile.environment, NODE_OPTIONS: "--trace-warnings", DEBUG: "sentinel" },
    pathToClaudeCodeExecutable: pinned.binaryPath, model: profile.model, settingSources: [], strictMcpConfig: true,
    tools: [], permissionMode: "default", includePartialMessages: true, maxTurns: 3, maxBudgetUsd: 0.1,
    canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
    systemPrompt: "Reply very briefly. This is a bounded integration experiment.",
    extraArgs: { "disable-slash-commands": null }, abortController: controller,
    spawnClaudeCodeProcess(spawnOptions) {
      invocation = spawnOptions;
      assert.equal(realpathSync(spawnOptions.command), pinned.binaryPath);
      child = spawn(spawnOptions.command, spawnOptions.args, {
        cwd: spawnOptions.cwd, env: spawnOptions.env, signal: spawnOptions.signal, stdio: ["pipe", "pipe", "pipe"],
      });
      const input = new PassThrough();
      input.on("data", (chunk: Buffer) => outbound.push(Buffer.from(chunk)));
      input.pipe(child.stdin);
      child.stdout.on("data", (chunk: Buffer) => inbound.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk: Buffer) => errors.push(Buffer.from(chunk)));
      const current = child;
      return {
        stdin: input, stdout: current.stdout,
        get killed() { return current.killed; }, get exitCode() { return current.exitCode; },
        get signalCode() { return current.signalCode; }, kill: current.kill.bind(current),
        on: current.on.bind(current), once: current.once.bind(current), off: current.off.bind(current),
      };
    },
  };
  const session = query({ prompt: noInput(), options });
  try {
    const initialization = await session.initializationResult();
    assert(invocation);
    assert.equal(invocation.env.NODE_OPTIONS, undefined);
    assert.equal(invocation.env.DEBUG, undefined);
    assert.equal(initialization.account?.tokenSource, "none", "Baseline must be credential-free");
    const sent = Buffer.concat(outbound).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Frame);
    const request = sent.find((f) => f.type === "control_request" && (f.request as Frame)?.subtype === "initialize");
    assert(request, "SDK initialize frame captured");
    const recipe: LaunchRecipe = {
      command: invocation.command, args: invocation.args, initialization: request,
      environmentKeys: Object.keys(invocation.env).sort(), sdkVersion: pinned.sdkVersion,
    };
    writeJson(join(outputDirectory, "recipe.json"), recipe);
    writeJson(join(outputDirectory, "initialization.json"), initialization);
    assert.deepEqual(workerArgs(profile), invocation.args, "Direct launch reproduces SDK recipe exactly");
    return recipe;
  } finally {
    clearTimeout(timeout);
    release();
    session.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const current = child;
      await Promise.race([new Promise<void>((done) => current.once("exit", () => done())), delay(3000)]);
      if (current.exitCode === null && current.signalCode === null) current.kill("SIGKILL");
    }
    writeFileSync(join(outputDirectory, "stdin.ndjson"), Buffer.concat(outbound), { mode: 0o600 });
    writeFileSync(join(outputDirectory, "stdout.ndjson"), Buffer.concat(inbound), { mode: 0o600 });
    writeFileSync(join(outputDirectory, "stderr.txt"), Buffer.concat(errors), { mode: 0o600 });
  }
}

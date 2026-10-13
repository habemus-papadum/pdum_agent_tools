import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline";

// This process has one profile and one workspace for its whole lifetime. There
// is intentionally no request parameter that can change either boundary.
const config = process.env.CLAUDE_CONFIG_DIR;
const work = process.env.SPIKE_STORAGE_WORK;
if (!config || !work || process.env.SPIKE_STORAGE_HELPER !== "1") {
  throw new Error("storage-helper requires an explicit isolated profile and workspace");
}

// Standalone storage must not accidentally become a query/CLI launch. Patch
// before importing the SDK and expose the counter as evidence in each response.
const childProcess = createRequire(import.meta.url)("node:child_process") as Record<string, unknown>;
const subprocessCommands: string[] = [];
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = childProcess[name] as (...args: unknown[]) => unknown;
  childProcess[name] = (...args: unknown[]) => {
    const command = basename(String(args[0]));
    subprocessCommands.push(command);
    // Missing-session resolution can ask git for its worktree root. That is
    // still standalone storage; launching Claude Code would violate the test.
    if (command !== "git") throw new Error(`Standalone storage attempted unexpected subprocess: ${command}`);
    return original.apply(childProcess, args);
  };
}
syncBuiltinESMExports();
const sdk = await import("@anthropic-ai/claude-agent-sdk");
const dir = resolve(work);

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let id: unknown;
  try {
    const request = JSON.parse(line) as {
      id: number;
      operation: string;
      sessionId?: string;
      title?: string;
      upToMessageId?: string;
    };
    id = request.id;
    let result: unknown;
    switch (request.operation) {
      case "list":
        result = await sdk.listSessions({ dir, includeWorktrees: false });
        break;
      case "info":
        result = await sdk.getSessionInfo(request.sessionId!, { dir }) ?? null;
        break;
      case "read":
        result = await sdk.getSessionMessages(request.sessionId!, { dir });
        break;
      case "rename":
        await sdk.renameSession(request.sessionId!, request.title!, { dir });
        result = true;
        break;
      case "fork":
        result = await sdk.forkSession(request.sessionId!, {
          dir,
          ...(request.title === undefined ? {} : { title: request.title }),
          ...(request.upToMessageId === undefined ? {} : { upToMessageId: request.upToMessageId }),
        });
        break;
      default:
        throw new Error(`Unknown storage operation: ${request.operation}`);
    }
    process.stdout.write(`${JSON.stringify({ id, ok: true, result, pid: process.pid, subprocessCommands })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      id, ok: false, error: error instanceof Error ? error.message : String(error),
      pid: process.pid, subprocessCommands,
    })}\n`);
  }
}

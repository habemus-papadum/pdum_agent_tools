import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const appRoot = join(repoRoot, "typescript/apps/orchestrator");

async function within(promise, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(description)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Own one frontend and one coordinator. No provider agents, credentials or login are loaded. */
export async function startDevInstance(options = {}) {
  const directory = options.stateDirectory
    ? resolve(options.stateDirectory)
    : await mkdtemp(join(tmpdir(), "pdum-orchestrator-dev-"));
  if (options.stateDirectory) await mkdir(directory, { recursive: false, mode: 0o700 });
  const supervisorId = randomUUID();
  const python =
    options.python ??
    join(repoRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const workspace = resolve(options.workspaceDirectory ?? repoRoot);
  let child,
    exited,
    vite,
    ready,
    details,
    closing,
    closed = false;
  let stderr = "";
  let recordWrite = Promise.resolve();
  const persist = (state, extra = {}) => {
    const value = JSON.stringify({ ...details, state, ...extra }, null, 2);
    const write = async () => {
      const temporary = join(directory, `.dev-instance-${randomUUID()}.json`);
      await writeFile(temporary, value, { mode: 0o600 });
      await rename(temporary, join(directory, "dev-instance.json"));
    };
    recordWrite = recordWrite.then(write, write);
    return recordWrite;
  };
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      await vite?.close();
      if (child && child.exitCode === null && child.signalCode === null) {
        if (ready) {
          try {
            await fetch(`${ready.url}/api/stop`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ instanceId: ready.instanceId }),
              signal: AbortSignal.timeout(2000),
            });
          } catch {
            /* Owned stdin/child handle remains the cleanup path, never a PID found by port. */
          }
        }
        child.stdin.end();
        try {
          await within(exited, 5000, "Coordinator did not stop after EOF");
        } catch {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          try {
            await within(exited, 3000, "Coordinator did not stop after SIGTERM");
          } catch {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await within(exited, 3000, "Coordinator cleanup unknown");
          }
        }
      }
      await persist("stopped", {
        stoppedAt: new Date().toISOString(),
        coordinatorExitCode: child?.exitCode ?? null,
      });
    })());
  try {
    child = spawn(
      python,
      [
        "-m",
        "pdum.orchestrator",
        "serve",
        "--host",
        options.host ?? "0.0.0.0",
        "--port",
        "0",
        "--state-directory",
        join(directory, "coordinator"),
        "--workspace-directory",
        workspace,
        "--exit-on-stdin-eof",
      ],
      { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
    );
    exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.on("error", () => {
      /* EOF races are settled by the owned child exit. */
    });
    const lines = createInterface({ input: child.stdout });
    ready = await within(
      new Promise((done, reject) => {
        child.once("error", reject);
        child.once("exit", () => reject(Error(`Coordinator exited before readiness: ${stderr}`)));
        lines.on("line", (line) => {
          try {
            const value = JSON.parse(line);
            if (value.type === "orchestrator-ready") {
              if (value.pid !== child.pid || value.apiVersion !== "0") {
                reject(Error("Unexpected coordinator identity/version"));
                return;
              }
              done(value);
            }
          } catch {
            /* Non-readiness stdout does not claim that startup succeeded. */
          }
        });
      }),
      20000,
      "Coordinator startup timed out",
    );
    details = {
      type: "dev-ready",
      supervisorId,
      pid: process.pid,
      instanceId: ready.instanceId,
      stateDirectory: directory,
      workspaceDirectory: workspace,
      coordinator: ready,
      frontendUrl: null,
    };
    vite = await createServer({
      root: appRoot,
      configFile: join(appRoot, "vite.config.ts"),
      cacheDir: join(directory, "vite-cache"),
      logLevel: "error",
      plugins: [
        {
          name: "orchestrator-dev-identity",
          configureServer(server) {
            server.middlewares.use("/__dev/instance", (_req, res) => {
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(details));
            });
          },
        },
      ],
      server: {
        host: options.host ?? "0.0.0.0",
        port: options.port ?? 0,
        proxy: { "/api": { target: ready.url } },
      },
    });
    await vite.listen();
    const address = vite.httpServer.address();
    if (!address || typeof address === "string") throw Error("Frontend has no TCP address");
    details.frontendUrl = `http://localhost:${address.port}/`;
    await persist("running");
    child.once("exit", () => {
      if (!closed)
        void persist("backend-exited", { coordinatorExitCode: child.exitCode }).catch((error) =>
          console.error(String(error)),
        );
    });
    return { ...details, url: details.frontendUrl, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Startup and cleanup failed");
    }
    throw error;
  }
}

export { repoRoot };

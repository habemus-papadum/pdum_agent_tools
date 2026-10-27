import { startDevInstance } from "./index.mjs";

const args = process.argv.slice(2);
function option(name) {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}
if (args.includes("--help")) {
  console.log(
    "pnpm dev [--host ADDRESS] [--port PORT] [--state-directory NEW_PATH] [--workspace-directory PATH]",
  );
} else {
  const instance = await startDevInstance({
    host: option("--host"),
    port: option("--port") === undefined ? undefined : Number(option("--port")),
    stateDirectory: option("--state-directory"),
    workspaceDirectory: option("--workspace-directory"),
  });
  console.log(JSON.stringify({ ...instance, close: undefined }));
  let stopping;
  const stop = () =>
    (stopping ??= instance.close().then(
      () => {
        process.exitCode = 0;
      },
      (error) => {
        console.error(String(error));
        process.exitCode = 1;
      },
    ));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

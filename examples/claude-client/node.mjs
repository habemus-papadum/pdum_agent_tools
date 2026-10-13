import { query } from "@anthropic-ai/claude-agent-sdk";
import { parseArgs } from "node:util";
import { fullProbe, probe } from "./common.js";
import { remoteProcess } from "./node-transport.mjs";

const [baseUrl, profileId, ...flags] = process.argv.slice(2);
if (!baseUrl || !profileId) {
  throw new Error("Usage: node node.mjs MANAGEMENT_URL PROFILE_ID [--live] [--resume SESSION_ID] [--full --other-profile PROFILE_ID]");
}
const { values } = parseArgs({
  args: flags,
  options: {
    live: { type: "boolean", default: false },
    resume: { type: "string" },
    full: { type: "boolean", default: false },
    "other-profile": { type: "string" },
  },
});
if (values.full && !values.live) throw new Error("--full requires --live: it submits four paid turns");
if (values.full && values.resume) throw new Error("--full creates its own source conversation; omit --resume");
if (values.full && !values["other-profile"]) throw new Error("--full requires --other-profile for isolation checks");
if (!values.full && values["other-profile"]) throw new Error("--other-profile is used only with --full");
const selectedProbe = values.full ? fullProbe : probe;
let report;
try {
  report = await selectedProbe((worker, prompt, hooks) => query({
    prompt,
    options: {
      hooks,
      // Launch settings belong in the management request. This callback replaces
      // the SDK's local process spawning using its documented extension point.
      spawnClaudeCodeProcess: () => remoteProcess(worker.websocketUrl),
    },
  }), {
    baseUrl, profileId, live: values.live,
    resume: values.resume, otherProfileId: values["other-profile"],
  });
} catch (error) {
  report = error.report ?? { status: "failed", error: String(error) };
  process.exitCode = 1;
}
report.client = "official Node SDK with public SpawnedProcess adapter";
report.sdkVersion = "0.3.296";
console.log(JSON.stringify(report, null, 2));

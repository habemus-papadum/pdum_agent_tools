import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolvePinnedClaude, writeJson } from "../../014-claude-app-server/src/launch.js";
import { runProfileProbe } from "./profile-probe.js";
import { runLifecycleProbe } from "./lifecycle-probe.js";

const base=resolve(import.meta.dirname,"../../../artifacts/016-claude-client-sessions");
mkdirSync(base,{recursive:true,mode:0o700});const out=mkdtempSync(join(base,"run-"));
const report={date:new Date().toISOString(),versions:resolvePinnedClaude(),node:process.version,
  profiles:await runProfileProbe(join(out,"profiles")),lifecycle:await runLifecycleProbe(join(out,"lifecycle")),
  modelRequests:0,modelCostUsd:0,browser:"Run probe:browser --live separately for the actual browser + Haiku flow"};
writeJson(join(out,"report.json"),report);
console.log(JSON.stringify({status:"passed",artifacts:out,modelRequests:0,modelCostUsd:0}));

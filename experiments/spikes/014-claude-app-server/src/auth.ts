import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";

/** Resolve only explicitly selected authentication; never serialize credential values. */
export function liveAuthentication(keychain = false): { environment: Record<string, string>; provenance: string } {
  if (keychain) {
    if (process.platform !== "darwin") throw new Error("--keychain requires macOS");
    const result = spawnSync("/usr/bin/security", ["find-generic-password", "-a", userInfo().username, "-w", "-s", "Claude Code-credentials"], { encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) throw new Error("Selected Claude Keychain credential is unavailable");
    let token: unknown;
    try { token = (JSON.parse(result.stdout) as {claudeAiOauth?: {accessToken?: unknown}}).claudeAiOauth?.accessToken; }
    catch { throw new Error("Selected Claude Keychain credential has an unsupported format"); }
    if (typeof token !== "string" || !token) throw new Error("Selected Claude Keychain credential has no access token");
    return {environment:{CLAUDE_CODE_OAUTH_TOKEN:token},provenance:"explicit --keychain; existing macOS Claude Code-credentials access token, not refreshed"};
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return {environment:{CLAUDE_CODE_OAUTH_TOKEN:process.env.CLAUDE_CODE_OAUTH_TOKEN},provenance:"explicit CLAUDE_CODE_OAUTH_TOKEN"};
  if (process.env.ANTHROPIC_API_KEY) return {environment:{ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY},provenance:"explicit ANTHROPIC_API_KEY"};
  throw new Error("--live requires CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, or explicit --keychain");
}

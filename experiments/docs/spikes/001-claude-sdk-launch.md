# 001 — Which Claude Code does the SDK launch?

**Question.** Can we pin the SDK's Claude Code executable, inspect the complete launch, and isolate it from the developer's normal installation?

**Result.** Yes. Observed on 2026-10-12: TypeScript Agent SDK **0.3.296** starts native Claude Code **2.1.296** from its installed platform package. Both its default resolver and an explicit `pathToClaudeCodeExecutable` launched the same workspace binary, even with a restricted `PATH`. The public `spawnClaudeCodeProcess` hook exposes the actual command, argument vector, environment, working directory, and cancellation signal. macOS syscall tracing is unnecessary for this boundary. Anthropic also documents the [optional-dependency binary packaging](https://code.claude.com/docs/en/agent-sdk/quickstart).

The important isolation finding is that **omitting `settingSources` loads user, project, and local configuration** in this version. Four real, credential-free CLI initializations tested this with synthetic output-style settings:

| Case | Observed style | What it proves |
| --- | --- | --- |
| Bundled binary, `settingSources: []` | `default` | User/project fixture settings excluded |
| Explicit binary, `settingSources: []` | `default` | Explicit path works with the same isolation |
| `settingSources` omitted | `Learning` | Project fixture loaded |
| `settingSources: ["user"]` | `Explanatory` | User fixture loaded, project fixture excluded |

Every initialization reported the expected executable version and `account.tokenSource: "none"`. A separate `--version` invocation agreed. No user prompt or model request was sent.

**Reproduce.** From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agent-spike/001-claude-sdk-launch probe
pnpm --filter @agent-spike/001-claude-sdk-launch typecheck
```

The [probe](../../spikes/001-claude-sdk-launch/src/probe.ts) writes a fresh `artifacts/001-claude-sdk-launch/run-*` directory: executable and SDK hashes, `cli-help.txt`, exact Level 0 invocation, initialization request/response, stderr, assertions, and source excerpts. Synthetic config/work directories live under the system temporary directory; their paths are recorded. Artifact files have mode `0600`. Full environment capture is suitable here only because the child receives an explicit credential-free environment.

**Isolation and auth.** Use a dedicated `cwd` and `CLAUDE_CONFIG_DIR`, `settingSources: []`, `strictMcpConfig: true`, auto memory disabled, and an explicitly constructed `env`. Supplying `env` replaces the inherited environment; it does not merge it. Ordinary settings isolation does not remove host managed policy or provide filesystem/process isolation. [The documented exceptions](https://code.claude.com/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control) explain why these are separate concerns.

On macOS, changing `CLAUDE_CONFIG_DIR` also selects a different Keychain entry, so a separate config root does **not** automatically share login. [Credential storage](https://code.claude.com/docs/en/authentication#credential-management) and [`CLAUDE_CODE_OAUTH_TOKEN`](https://code.claude.com/docs/en/env-vars) provide a route to separate state from authentication: supply an appropriate token explicitly. This spike did not read, refresh, or modify the developer's credentials, or verify a paid request. [Anthropic's current subscription notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says Agent SDK subscription usage remains available; authentication and entitlement are separate from the launch mechanics verified here.

**Versions and limits.** macOS 26.6.2 / Darwin 25.6.0, arm64, Node 26.10.0, pnpm 11.9.0. SDK SHA-256 `5cf6f15237f9c84e6e5b724a10180478732457168921d7aa3e02632037cce299`; binary SHA-256 `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937`. The package provides readable declarations and minified JavaScript; the public repository is not an open-source TypeScript implementation of the SDK. [Its licensing notice](https://github.com/anthropics/claude-agent-sdk-typescript#license-and-terms) points to commercial terms. The detailed [launch map](001-claude-sdk-launch-details.md) distinguishes observed behavior from source inspection and covers additional controls, argv, and protocol details.

# Spike 014: profile storage and branching

The standalone Agent SDK helpers can supply the manager's local storage layer.
The credential-free probe uses the real SDK and filesystem with explicitly
synthetic transcripts; it does not simulate successful provider responses.
On 2026-10-13, two simultaneous helpers with different config roots and the same
workspace each discovered only their own conversation. Reading the other
profile's session returned no messages; metadata lookup returned no result;
rename and fork failed without changing the other profile.

The tested package is `@anthropic-ai/claude-agent-sdk` 0.3.296, bundling Claude
Code 2.1.296, on macOS arm64 with Node 26.10.0. SDK and executable SHA-256 values,
source-inspection markers, helper PIDs, replies and assertions are recorded in
each ignored output directory. A package hash identifies the inspected artifact,
not a private source revision.

## Observed storage behavior

| Operation | Result |
| --- | --- |
| Concurrent list/read in two profiles sharing a workspace | Each helper sees its own profile. |
| Rename | `renameSession` appends metadata; a subsequent independent `getSessionInfo` sees the title. |
| Full standalone fork | Four fixture conversation messages copied; fresh session and message UUIDs; identical message content. |
| Selected-message fork | The chosen second message is included; two later messages are excluded. |
| Original after both forks | SHA-256 unchanged from its post-rename value. |
| Saved `cost-state` metadata | The original retains its synthetic cost state; full and selected standalone forks omit it. |
| Partially written trailing JSONL row | Fork succeeds with the preceding four complete messages; it omits the incomplete fifth row. The original exposes five messages after the writer finishes. |
| Worker launches during helper operations | None. Instrumented process creation permits only Git; missing-session lookups asked Git about worktrees. |

The interrupted-writer case is a deterministic local file experiment. It proves
that successful forking does not by itself establish that all pending transcript
writes were included. It does not establish how a running Claude worker flushes
its transcript. Initially expose fork after a stopped worker or a separately
confirmed persisted boundary. A `result` frame alone has not been qualified as a
flush acknowledgement.

## Boundary and path findings

`listSessions`, `getSessionInfo`, `getSessionMessages`, `renameSession` and
`forkSession` take a project directory, but no per-call local config root. The
inspected SDK resolves that root from process-global `CLAUDE_CONFIG_DIR`.
Changing the manager's environment around overlapping asynchronous calls would
therefore make profile selection depend on global mutable state.

Use a small helper process with fixed environment per profile. The probe also
fixes its workspace at helper startup and does not accept a path override in
requests. The manager chooses the profile/helper and explicit session ID; the
helper delegates transcript parsing and mutation to the public SDK. This is a
storage adapter, independent of live worker initialization and browser transport.

The SDK canonicalizes the project path through `realpath`. A fixture created
under macOS's `/var` alias initially failed discovery because the lookup used
`/private/var`. The passing harness canonicalizes its temporary workspace first.
Production code should let the SDK resolve project paths instead of reproducing
its encoded directory naming algorithm. The probe reproduces that algorithm only
to create short-path, synthetic test inputs.

`listSessions({ includeWorktrees: false })` avoids list expansion. The other
helpers have no equivalent option: source inspection and process instrumentation
show that an unsuccessful direct lookup can query Git for worktree paths.
Profile separation still holds because transcript reads stay beneath the helper's
fixed config root. Workspace separation inside one profile is a different policy
and is not established by this test.

## Live result and cost accounting

The four-turn live sequence passed on 2026-10-13: create one persisted
Haiku conversation per profile, fork at an assistant message using the standalone
helper, resume that fork and recall its marker, then launch a second branch with
`resume` plus `forkSession: true`. It checks inherited context, session IDs and
the original transcript's hash after both resumes. Workers use isolated homes,
config roots and workspaces, and are closed before storage assertions. No ordinary
Claude configuration or session is read.

The run used the user's explicitly authorized existing macOS Keychain access
token, without refreshing it. The two persisted profiles remained isolated; the
selected standalone fork and launch-time fork both recalled the original marker
and had the expected session identity. The original transcript stayed byte
identical after both resumes. Evidence is in the ignored
`artifacts/014-claude-app-server/run-9TAxoR/storage/` directory.

| Live attempt | Saved baseline | Incremental SDK estimate |
| --- | ---: | ---: |
| Create profile A conversation | $0 | $0.00005030 |
| Create profile B conversation | $0 | $0.00005020 |
| Resume selected standalone fork | $0 | $0.00011430 |
| Launch-time fork | $0.00005030 | $0.00001018 |
| Total new work | | **$0.00022498** |

All four attempts succeeded, with no unknown incremental amounts. The independent
list-price estimate is $0.00018388–$0.00022498; its range reflects cache-write TTL.
Fixture probes make zero provider requests and cost $0. The live path selects
`claude-haiku-5-5` explicitly,
allows one turn and $0.05 SDK budget per attempt, caps output at 256 tokens through
`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, and sets a 60-second deadline.
Each attempt records status, result subtype, tokens, cache usage, SDK-reported
cost and a dated independent estimate. A failure without final usage is marked
as potentially chargeable. Actual subscription billing remains unknown.

`result.total_cost_usd` and `modelUsage` are cumulative and may include the
resumed transcript's saved history. Summing them across these four attempts
would overcount. The ledger reads the source transcript's last valid `cost-state`
for that session before launching each resumed worker, records that baseline,
and subtracts it from the final totals. The parser follows the pinned native
schema: malformed later records do not replace an earlier valid one. Absence of
saved state restores a zero baseline. The standalone fork fixture confirms that
its new transcript has no saved cost state; the live launch-time fork inherited
the original's $0.00005030 baseline. Its $0.00006048 cumulative result therefore
represents $0.00001018 of new work, consistent with the per-turn token usage.

The report preserves raw cumulative values as `sdkCumulativeCostUsd` and
`sdkCumulativeModelUsage`, separately records `sdkIncrementalCostUsd` and token
deltas, and sums only known incremental amounts. Error results or regressing
counters produce unknown accounting, never a negative or assumed-free attempt.
`result.usage` is retained as `mainLoopTurnUsage`: it is per-turn but excludes
subagent and auxiliary query-pipeline usage, so it is not used as a replacement
for the full ledger. The SDK declarations state these semantics, and the native
schema/loader/restore excerpts are preserved under the discovery spike's ignored
`cost-*-source-excerpts.json` files. Two deterministic accounting regressions
test inherited history, malformed metadata and zeroed error results without
provider requests.

The independent estimate uses the [Haiku 5.5 model pricing](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
verified on 2026-10-13: for these prompts below 100k tokens, input/output prices
are $0.10/$0.50 per million tokens; cache reads cost $0.01, and cache writes
$0.125 for five minutes or $0.20 for one hour. SDK `modelUsage` does not identify
cache-write TTL, so the ledger reports the corresponding estimate range.

## Reproduce

From `experiments/`:

```sh
pnpm --filter @agent-spike/014-claude-app-server probe:storage
pnpm --filter @agent-spike/014-claude-app-server exec tsx --test src/storage.test.ts src/storage-costs.test.ts
# Requires an explicitly supplied ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN:
pnpm --filter @agent-spike/014-claude-app-server probe:storage --live
```

Outputs are beneath ignored `artifacts/014-claude-app-server/storage/` or
`storage-tests/`. The reusable entry point is `runStorageProbe(outputDir,
options)`. Authentication is supplied explicitly through `options.live`; the
helper processes themselves receive no credentials. The report labels fixture
and live outcomes separately.

## External store scope

The SDK exposes an alpha `SessionStore` override on its helpers. Source inspection
also found that query-time resume hydration creates a temporary local config
directory, materializes transcript entries and may copy credentials and settings
from the selected config source. The hydration path can read the ordinary login
when no explicit config root/authentication is provided. This spike does not
enable it. Reusing standalone storage operations and reproducing hydration plus
write mirroring are separate tasks; retain local transcripts for the first server.
Forking copies conversation history, not the workspace or file undo snapshots.

# HP work integration

This round composes 050's scheduler, 051's portable jobs and the existing runtime
and MessagePort protocol. Start with the [high-level findings](../../../docs/hp-agent-work.md).
The [AIUI integration contract](../../../docs/specs/hp-aiui-integration.md) is the
next design baseline; actual cell integration remains future work.

## Run

From `experiments/`:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agent-spike/050-hp-parallel-tools test
pnpm --filter @agent-spike/051-hp-background-jobs test
pnpm --filter @agent-spike/052-hp-work-integration test
pnpm --filter @agent-spike/052-hp-work-integration typecheck
pnpm --filter @agent-spike/052-hp-work-integration build
HP_PUBLIC_ROOT="$PWD/spikes/052-hp-work-integration/dist" \
  node spikes/040-hp-integration/dev-server.mjs
```

Open the printed URL and select **Run local checks**, or call
`window.runHPWork()`. These are real Worker/MessagePort operations with scripted
model events, not paid provider calls. Separate 050 and 051 browser entry points
exercise their scheduler/job cases unchanged. Stop the foreground host with Ctrl-C.

Build uses the existing pinned Codex prompt loader, which requires the source
checkout described in [vendor setup](../../vendor/README.md). No credential is
included in browser build output.

The paid probes require explicit live mode and an existing ignored host `.env`:

```sh
node --env-file=../.env --import tsx spikes/052-hp-work-integration/live.mjs --live
HP_PUBLIC_ROOT="$PWD/spikes/052-hp-work-integration/dist" \
  node --env-file=../.env spikes/040-hp-integration/dev-server.mjs --live
```

For the second command, select **Run live probe** once or call
`window.runHPWork(true)`. Only the development host reads the key. Node allows
eight response creates, 512 output tokens each, a 100-second bound and USD 0.10
observed-usage ceiling. The reused browser host allows twelve creates, 24 observed
responses, 512 output tokens each, 120 seconds and USD 0.10; the client bounds
its scenario to 100 seconds. Luna only, reasoning none, default service, no
automatic retries. Probe limits are not runtime limits.

## Implemented integration

`AgentRuntime.startJob(threadId, spec)` stamps the runtime owner, originating
thread and current turn. Its `jobs` registry can be injected and shared with
`createNodeTools({cwd, jobs})`. A fork copies conversation state, not job ownership.
Job events are copied into runtime notifications and its journal. A terminal
event queues a `jobCompletion` input with a job ID and a brief status notice.
It wakes a mailbox wait but does not start an idle model. Tool output is read on
demand; the live probe supplies a `read_job` application tool for that purpose.

| RPC extension | Contract |
| --- | --- |
| `hp/job/list` | Optional owner/thread filters; snapshots of retained jobs. |
| `hp/job/read` | Read a current or completed job without starting model work. |
| `hp/job/events` | Retained events, optionally filtered by job ID and exclusive global sequence cursor `afterSeq`. |
| `hp/job/send` | Send a structured value to a job that advertises input support. Shell stdin remains `write_stdin`. |
| `hp/job/wait` | Wait with a caller-chosen `waitId`, optionally `timeoutMs`. |
| `hp/job/cancelWait` | Cancel only the matching wait on this connection. Other clients may use the same wait ID independently. |
| `hp/job/cancel` | Request cancellation of the execution itself. It can remain cancelling until its callback settles. |
| `hp/client/detach` | Graceful one-way client closure, releasing its waits and notifications while leaving work alone. |

These are HP extensions, not native Codex methods. Starting work is an application
callback/tool operation; the protocol does not evaluate arbitrary JavaScript.
An abrupt transport loss must call the disposer returned by `servePort` because
the portable Port interface itself has no universal close signal.

`runtime.dispose()` interrupts its turns, requests cancellation of jobs whose
owner is its run ID, and unsubscribes from shared-registry observation. It does
not close separately owned shell adapters or an entire shared registry. The host
closes those adapters explicitly. Read-only retained state remains inspectable.
Cancellation request is not proof that uncooperative code stopped.

## Qualification and evidence

The final combined Node test command covered 039 runtime, 042 host tools,
047 controls, 048 provider edges, 049 client composition, and 050–052 work:
**90 tests passed**. Some test entries contain multiple assertions/scenarios.
The browser separately passed the identical nine scheduler, ten job and four
integration scenarios: **23 portable scenarios**. Real subprocess tests run only
in Node/macOS. No AIUI lifecycle test or CPU Worker computation is claimed here.

The same `src/live.ts` ran under Node and inside Chrome's Worker. Its two selected
reads overlapped and produced 41. A model-started job waited for structured host
input beyond the initial turn; a subsequent explicit model turn read 73. Each
environment completed six provider responses. Node prompt records were verified
through the existing AIUI prompt toolkit; the browser used the same generated
instruction text and retained its wire evidence. This round did not independently
verify the browser wire against prompt-toolkit records.

All paths below are relative to ignored `experiments/artifacts/`:

| Evidence | Location |
| --- | --- |
| Final browser scheduler cases | `052-hp-work-integration/browser-parallel.json` |
| Final browser job cases | `052-hp-work-integration/browser-jobs.json` |
| Final browser runtime/client cases | `052-hp-work-integration/browser-integration.json` |
| Node live result, prompt records, wire and ledger | `052-hp-work-integration/live-1792346519350/` |
| Browser live selected results, job events and usage | `052-hp-work-integration/browser-live.json` |
| Browser raw wire and ledger | `040-hp-integration/browser-1792346535936/` |

Final lifecycle refinements (admission/start distinction, graceful detach,
runtime disposal and cleanup observation) were requalified by deterministic Node
and browser checks after the live success runs. No further paid inference was
needed for those changes. The test page had a missing-favicon HTTP 404; it did not
affect Worker execution.

## Usage ledger

18 October 2026 estimate, standard Luna rates per million tokens: uncached input
USD 0.10, cached input USD 0.01, cache writes USD 0.125, output USD 0.50. The
reused host ledgers record model, tier, token counts, rate basis and coverage.
All observed inputs were below the long-context pricing threshold.

| Probe | Responses with usage | Estimated USD |
| --- | ---: | ---: |
| Node parallel reads and background job | 6 | 0.000771220 |
| Chrome Worker parallel reads and background job | 6 | 0.000327715 |
| Total | 12 | **0.001098935** |

Actual account billing is unknown. Costs of this assistant and its delegated
implementation agents are not exposed and are excluded. Local tests and source
inspection made no provider calls. No new dependency versions, production
package, AIUI upstream change, commit, push or release were introduced.

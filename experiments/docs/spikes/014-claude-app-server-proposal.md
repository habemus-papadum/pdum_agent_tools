# Claude Code app server spike proposal

> **Follow-up status, 2026-10-13:** this proposal was investigated in
> [014](014-claude-app-server.md) and revised by [016](016-claude-client-sessions.md).
> The agreed lifetime is now client disconnect ending its worker, with the official
> SDK query owned by the client. A separate Python launcher has passed live
> browser/Node qualification. See the [checkpoint and next steps](../../../docs/claude-handoff.md)
> for current status; the original proposal below is retained as historical context.

**Status: proposed, 2026-10-13.** Can a small manager expose Claude Code to browser and Node clients, reuse the Agent SDK's control logic, and keep sessions independent of client connections? The promising starting point is the official browser SDK connected to a manager that launches one Claude Code process per active conversation. Compatibility, shared-client ownership, and recovery remain hypotheses to test.

The experiment should choose a launch strategy, establish which SDK components can be reused, and identify the minimum server responsibilities. Success means a demonstrated path to an app server with profiles, concurrent sessions, storage operations, and replaceable transports. It does not require full Codex protocol parity or a production implementation.

## What the existing code establishes

The inspected distribution is `@anthropic-ai/claude-agent-sdk@0.3.296`, bundling Claude Code `2.1.296`. The prior [launch spike](001-claude-sdk-launch.md) observed isolated initialization, executable selection, and `spawnClaudeCodeProcess`. The following additional findings are source inspection or documentation, not observed behavior of the proposed server:

| Component | Finding | Implication for the experiment |
| --- | --- | --- |
| Process launch | The Node SDK assembles argv and environment and starts a process with piped stdin/stdout. Its public spawn hook receives the command, args, cwd, env, and cancellation signal. | Compare our launcher against an SDK-generated launch recipe instead of guessing the flags. |
| Query control | The published browser bundle constructs a WebSocket or SSE transport and passes it to an internal query implementation. That implementation handles initialization, correlated controls, hooks, permissions, dialogs, and SDK MCP callbacks. | Try the existing browser export before introducing a build patch. |
| WebSocket framing | The browser transport sends newline-delimited JSON and parses incoming lines. The CLI uses newline-delimited JSON over stdio. | A relay is plausible; matching framing does not establish matching initialization or lifecycle semantics. |
| Session discovery | `listSessions`, `getSessionInfo`, and `getSessionMessages` are standalone storage helpers. The inspected implementations read local data or dispatch to a supplied `SessionStore`; they do not launch a query. | Reuse these on the server, independently of the live transport. Browser clients call management endpoints. |
| Forking | Standalone `forkSession` creates a new transcript, remaps message UUIDs and session identity, and preserves conversation links. The declarations say file undo snapshots are not copied. Separately, `query({ options: { resume, forkSession: true } })` forks while launching. | Test storage-only branching and launch-time branching separately. Neither implies a filesystem or live-process snapshot. |
| External storage | SDK `SessionStore` support mirrors local transcript writes and materializes stored transcripts locally for resume. | Reusing storage helpers is easier than reusing the whole hydration/mirroring lifecycle behind a raw relay. Start with local storage. |
| Remote Control | Anthropic documents terminal and remote interaction with a locally executing conversation. Its browser/bridge transports also contain remote-session machinery; `/bridge` is alpha. | This establishes that shared interaction is possible in Anthropic's system, not that two SDK clients can safely share raw stdio. |

Local inspection targets are the spike 001 installation's `sdk.d.ts`, `sdk.mjs`, `browser-sdk.d.ts`, `browser-sdk.js`, and `bridge.d.ts`. Public references: [hosting](https://code.claude.com/docs/en/agent-sdk/hosting), [sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [external storage](https://code.claude.com/docs/en/agent-sdk/session-storage), [Remote Control](https://code.claude.com/docs/en/remote-control), and the [official Python control implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py).

## Proposed boundaries

```text
Browser or Node client
  management API: profiles, launch, list, fork, resume, stop
  session API: input, events, controls, callbacks
                         |
                 connection adapters
                         |
Manager: session registry, process ownership, routing, event history
        profile storage and SDK session helpers
                         |
              process stdin/stdout adapter
                         |
           Claude Code worker per active session
```

Keep profile identity, conversation ID, worker instance ID, and client connection ID distinct. A cold resume keeps conversation identity but changes the worker; reconnecting a browser should change only the connection. Profiles are our abstraction: executable/version, config root, workspace/config sources, model, instructions, MCP settings, permissions, and a server-side authentication reference. Two conversations may share a profile while remaining separate workers.

The manager owns worker lifetime. Socket closure must not close worker stdin or kill the worker. Explicit stop, process exit, client detachment, turn completion, and absence of background work are different states. Use explicit session IDs rather than “continue the newest session” when serving concurrent clients.

The core should consume and produce structured frames without depending on HTTP or WebSocket. Management operations and agent protocol frames need separate routing, even if they share one network connection. Begin with WebSocket and an in-memory connection adapter for tests; validate the same core through a Node stdio client adapter. SSE compatibility can follow if needed; Anthropic's SSE transport expects additional remote-service envelopes, so it is not interchangeable with raw JSON lines merely by changing URLs.

## Questions and bounded probes

### 1 Choose the launch strategy

Establish an official Node SDK baseline using the spike 001 custom spawner to capture the actual launch and initialization, with persistence enabled for later storage tests. Then launch the same pinned binary ourselves using that recipe and let the official browser SDK supply the control handshake through a relay.

Test more than `--output-format json`: this requires bidirectional `stream-json`. Compare argv, injected environment variables, initialization payload, permission prompt configuration, partial-message settings, SDK MCP registration, and graceful exit. Determine which configuration belongs in argv and which belongs in initialization. Do not initialize the same worker from both a server SDK query and a browser SDK query by accident.

Compare these alternatives with the same small turn and approval probe:

| Alternative | Reason to test | Decision criterion |
| --- | --- | --- |
| Our launcher plus official browser client | Gives the manager direct process ownership and preserves raw frames. | Prefer if a bounded launch/configuration mapping reproduces required behavior. |
| Official Node SDK owns the worker; remote clients proxy its methods | Reuses launch, initialization, and callback handling. | Fallback if raw relay semantics require substantial duplication; measure what is hidden or transformed. |
| Official Node SDK with a virtual `SpawnedProcess` connected to our manager | Could let existing Node query logic communicate over a remote connection using the public spawn hook. | Verify stream, exit, error, cancellation, and close semantics; attaching must not accidentally launch or stop a shared worker. |

The spawn hook replaces a process interface, not the entire SDK transport. It is not a general browser transport hook. Merely using it to spawn a worker leaves the Node query reading stdout and managing initialization; it does not produce a passive relay automatically.

If the browser export fails because of a narrow transport assumption, identify the exact assumption before considering a build patch. Record whether changing the transport factory alone suffices, or whether query/control logic must change. Pin and hash patched input, assert a unique patch target, and fail on version drift. A separately maintained query implementation is the last option.

### 2 Verify browser and Node client parity

Connect the official browser export to our WebSocket endpoint in a real browser, and test the same export under Node where supported. Also test the Node root SDK through the virtual-process adapter above. Determine which clients work unchanged, with an adapter, or with a package patch.

Exercise a short live turn, streamed input, partial output, a permission decision, interrupt, and one SDK-hosted tool or hook callback. Verify that client controls and worker callbacks resolve against the correct request IDs, and that a result ends a turn rather than the entire session. A browser-hosted callback and a server-hosted callback need explicit ownership; executable JavaScript functions cannot simply be serialized into a profile.

Repeat a small protocol exchange through the in-memory and stdio connection adapters. Preserve unknown frames rather than silently dropping SDK features not enumerated by the spike. Record genuine event gaps and transformations instead of presenting transport independence as complete API parity.

### 3 Reuse discovery and fork helpers across profiles

Create two profiles and two persisted conversations, then close their workers. From a standalone helper process, list, read, rename, and fork their sessions without launching Claude Code. Resume the fork and verify inherited context, a new session ID, an unchanged original, and isolation between profiles. Include a branch at a selected message ID.

Inspect how local helpers resolve `CLAUDE_CONFIG_DIR` and project/worktree paths. They take no per-call query environment; changing the manager's global environment for overlapping profile requests would be unsafe. Prefer a helper process with fixed environment per profile unless inspection reveals a supported per-call mechanism. Test that one profile cannot discover or mutate another profile's sessions through the management API.

Fork first from a stopped worker or a confirmed persisted boundary. Separately inspect whether an active worker can expose a consistent fork point and whether pending transcript writes matter. Keep transcript branching separate from workspace copying and file checkpointing. Use a small in-memory `SessionStore` contract probe only if it resolves the helper boundary; distributed storage is a follow-up.

### 4 Determine shared-client semantics

Attach a browser and Node client to one worker. First test one controller plus one observer; then test two initialized SDK clients. Record whether another `initialize` changes hooks, callback IDs, tools, permissions, or pending requests. Check whether replies are delivered correctly when both clients issue controls concurrently.

Use these adversarial cases: colliding client request IDs, two answers to one permission request, controller disconnect during a callback, an observer issuing an interrupt, and two nearly simultaneous user inputs. The outcomes must reveal who owns each callback and whether inputs are queued, steer an active turn, or are rejected. Multiple independent workers provide session concurrency; one worker need not perform independent simultaneous turns.

A plain broadcast relay may be sufficient for observers but is not assumed sufficient for independent controllers. If needed, the manager namespaces request IDs, routes responses to their origin, assigns callback ownership, orders inputs, and rejects duplicate or stale decisions. Initialization may also require mediation. Measure whether that mediation can preserve the official client API or requires our own small client wrapper.

Pass with the strongest demonstrated mode: observers only, exclusive controller with handoff, or simultaneous controllers. Document any mode that cannot work with unmodified clients. Remote Control's behavior is motivation, not proof of raw-protocol compatibility.

### 5 Test reconnect and recovery

Disconnect one client during a turn while another continues observing. Reconnect with a cursor and confirm that committed events are replayed once in server order, live deltas are handled explicitly, and unresolved approvals reappear without duplicate execution. Compare server event history with persisted transcripts: transcript helpers need not contain live deltas, controls, or pending callback state.

Stop and cold-resume a conversation; separately kill a worker and restart the manager. Record recovered context, lost pending requests, background-task behavior, and process cleanup. Do not automatically retry an ambiguously accepted user input: test input IDs/receipts where available, otherwise expose the uncertainty. A minimal bounded replay buffer is enough for the reconnect probe; a durable event journal is justified only by the manager-restart requirement.

Run two workers concurrently and confirm messages, controls, profiles, and stop operations stay independent. Prove that a slow observer cannot stall the worker or other clients: cap buffers and disconnect or require resynchronization for an overflowing observer.

### 6 Test unmodified Claude Code compatibility

There are three different compatibility tests, and each needs its own result:

1. **Headless executable as worker:** run unmodified Claude Code in stream-json mode behind our server. The worker should observe the ordinary SDK handshake and protocol, without a custom CLI build. This is a core acceptance test.
2. **Executable connecting outward to our server:** inspect the pinned binary for a remote transport entry point such as `--sdk-url`, then perform a local, credential-free handshake if accepted. A historical [issue in Anthropic's tracker](https://github.com/anthropics/claude-code/issues/28513) mentions this flag; the public [CLI reference](https://code.claude.com/docs/en/cli-reference) does not document it. Establish direction, flags, authentication, and supported messages in this version. An outward connection may still be a worker connection rather than a terminal client attaching to an existing worker.
3. **Interactive terminal UI as an additional client:** look for a supported attach endpoint or inspect a narrowly relevant transport path. If possible, type locally while the browser observes, then type remotely while the terminal observes, against the same worker and conversation. Sharing transcripts or resuming the conversation in a second process does not pass this test. Stop after source/CLI inspection and one bounded local attempt if no usable client mode exists; report the missing boundary rather than building a terminal emulator or recreating Anthropic's backend.

An unmodified SDK client passing the relay test does not imply that the terminal UI can attach. Likewise, changing the model API base URL changes inference routing, not the session-control transport.

## Execution scope and evidence

Implement under `spikes/014-claude-app-server/` with its own runnable probe and workspace manifest. Keep dependencies in the root pnpm catalog. Use the existing version pins and spike 001 executable resolution. Leave extraction into shared packages until the experiment reveals a useful common boundary.

Stage the work: launch/client compatibility first; storage and two-client behavior next; reconnect/concurrency last. The terminal-client experiment is a bounded stretch investigation. Failures should narrow the design and still produce useful results; full SDK feature coverage, cloud backend emulation, distributed scheduling, and production profile administration are outside this spike.

Use isolated config roots and temporary workspaces, with explicit server-side authentication supplied through existing experiment mechanisms. Inspect external-store hydration before enabling it so it cannot copy normal developer configuration or credentials. Do not read or change normal sessions, settings, or login material. Record credential names and provenance, never values.

Begin with credential-free initialization and deterministic failure injection. Validate the actual integration with inexpensive live turns using an explicitly selected available Claude model. Cap turns, output, and individual query budgets; plan a total at or below roughly $0.50 and reassess before materially exceeding it. Do not silently change models or billing paths. Record input, cached input, output, and a dated price-based estimate separately from actual billing.

Save executable/package hashes, launch metadata, local inspection markers, process IDs, connection/session mappings, assertions, frame traces, and replay checks under ignored `artifacts/014-claude-app-server/`. Capture raw protocol privately and redact summaries. Record actual runtime versions and public source revisions when used; an npm package hash does not identify the CLI's private source revision.

The runnable result should reproduce the tested modes, report pass/fail/unsupported with evidence, and clean up only its own process trees. After execution, add a roughly one-page result at `docs/spikes/014-claude-app-server.md`, link detailed evidence, and update the results index. This proposal records no new runtime validation.

## Decisions the result must support

The final recommendation should name the launch owner, reusable SDK components, supported browser and Node clients, storage boundary, strongest shared-client mode, reconnect guarantees, transport adapters, and exact CLI compatibility level. Quantify custom routing and any patch surface rather than equating a successful text turn with an app server.

Proceed with a direct launcher if the existing client works over a small relay and required launch configuration is tractable. Prefer a server-owned official SDK if callback/initialization mediation dominates the work. Prefer a narrow transport patch only when it demonstrably avoids duplicating query logic. If raw clients cannot share ownership safely, retain one protocol controller per worker and expose multiple application clients through the manager.

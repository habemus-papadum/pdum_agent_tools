# 068 — Claude processes can outlive attached clients

**25 October 2026.** The proposed simple architecture works for the cases tested:
a service owns a native Claude process, forwards client bytes into stdin, and
replays/broadcasts native stdout to any attached clients. No official conversation
SDK, server-side input interpretation, manufactured acknowledgement or exclusive
controlling client was needed. The production launcher remains unchanged; this
is working disposable code and evidence for its replacement direction.

**Follow-up, 26 October:** [071](071-claude-sdk-replay.md) now tests official SDK
clients against this same process owner. It qualifies reuse with a client-side
replay/reconnection layer; the SDK-free probe below did not establish that SDK
reuse was impossible or require a replacement query implementation.

## What we observed

- **Clients can come and go.** A real Haiku prompt and Bash tool finished while
  no clients were attached. Two later clients received identical complete stdout
  and could continue interacting with the same process.
- **Claude supplies acknowledgement and execution state.** With
  `--replay-user-messages`, native user echoes preserved submitted UUIDs.
  `command_lifecycle` reported queued, started and completed for each input.
  Two clients submitted concurrently; Claude queued and completed both in order.
  That selected result does not promise every input always becomes a separate turn.
- **Shared questions can be resolved from the native feed.** Both clients received
  one actual permission request. Claude reflected the accepted allow response on
  stdout; a later opposing deny did not override it and was not echoed. A late
  client replayed the request and its resolution without reviving the question.
  The reflected decision does not identify which browser sent it.
- **Native reconciliation is available.** Repeated `initialize` succeeded, listing
  the current pending permission request before resolution and none afterward.
  Both clients also received correlated responses to ordinary control requests.
- **Not every failure is a structured rejection.** An unsupported control subtype
  produced a correlated native error. Malformed JSON instead ended Claude with
  exit 1 and a stderr diagnostic. A pending client action must remain unknown
  when native evidence does not establish acceptance or rejection.

The service records stdin, stdout and stderr separately. Its normal attachment
feed contains **only stdout**, so recorded input is never presented as provider
acceptance. Replay-start/replay-end, sequence numbers and process-exit markers
are transport metadata, distinct from Claude messages. Full payloads are retained;
there are no image-pruning or snapshot optimizations.

## What belongs where

| Service | Client |
| --- | --- |
| Launch/list/stop owned native processes | Generate unique native request/message IDs |
| Serialize complete incoming transport writes to stdin unchanged | Interpret native echoes, responses and command lifecycle |
| Retain ordered bytes and attach a replay/live subscriber | Rebuild transcript/state during replay without executing actions |
| Report process exit and journal/client backlog or recording errors | Resolve shared questions from native responses; preserve unknown outcomes |
| Explicitly reclaim a stopped process's journal | Show replay progress and current interaction state |

The proposed per-process journal is provisionally beneath the profile's `.aiui`
directory. It supplies attachment to this running process; it is not a replacement
for native saved history or DuckDB ingestion. After process death, native
resume/fork starts another process, as investigated separately in 064. Restarting
the owner and adopting old pipes or processes was not attempted.

## Strength of the evidence

Claude Code **2.1.310**, Python **3.14.7**, aiohttp **3.14.5**, psutil **7.2.2**, macOS;
Haiku resolved to **claude-haiku-5-5**. The installed SDK **0.3.296** type declarations
were a protocol reference only; no SDK runtime was used. The official
[CLI reference](https://code.claude.com/docs/en/cli-reference) describes the public
stream-json and user-replay flags; versioned live output establishes the outcomes above.

Nine native no-model checks and four byte-transport checks passed. The transport
checks include ten clients joining during fragmented output, split UTF-8/JSONL,
a 2 MiB final output before exit, and forwarding during a stalled journal writer.
Two actual Chrome contexts also shared control responses, detached, replayed
identical streams and stopped/reaped the process. See
[browser evidence](../../spikes/068-claude-feed-replay/browser-qualification.md).

The initial live harness passed its five ownership/concurrency checks but timed
out waiting for a permission request that harmless `printf` did not require.
A forced-permission follow-up then wrongly expected a cancellation message;
Claude had reflected the accepted response instead. The corrected final follow-up
passed six callback/replay checks. These harness failures and all six successful
model results are retained, rather than describing the entire sequence as one
clean run. All test processes were stopped.

Estimated provider usage was **USD 0.00283440**, including both failed harness
attempts. This is an API-equivalent estimate, not actual subscription billing or
implementation-assistant cost. See the [usage ledger](../../spikes/068-claude-feed-replay/usage-ledger.md).

## Architectural consequence and remaining limits

Proceed with independent process ownership and an SDK-free Claude client that
projects the native stream. Keep semantic coordination on the client. The server
still needs careful byte ordering, asynchronous recording/delivery and explicit
ownership cleanup, but it need not become a conversation state machine.

Before production promises, qualify active interruptions/steering through this
new path, larger sessions, first-initialize capability choices, callback types
beyond the selected tool permission, slow-client resource growth, owner failure
and journal reclamation. Those are focused qualification items; they do not
require private native recovery or another broad mock round. This spike did not
implement a generic client SDK, automatic action retry, crash recovery or remote
reconnection to an externally launched Claude process.

[Runbook and source map](../../spikes/068-claude-feed-replay/README.md) ·
[Detailed protocol observations](../../spikes/068-claude-feed-replay/protocol-notes.md)

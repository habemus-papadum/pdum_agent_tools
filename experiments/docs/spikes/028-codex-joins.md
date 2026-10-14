# 028 — Late joins, multiple responders and disconnects

**Observed, 14 October 2026:** Codex 0.162.1 supports multiple listeners and
responders through the existing launcher relay. `thread/resume` joins a running
thread and replays pending requests; `initialize` and `thread/read` do not do that.
There is no basis here for requiring one controller. There is also no basis for
automatic retries of `turn/start`: two concurrent submissions with the same
`clientUserMessageId` became two user items in one active turn; another submission
after completion created a new turn.

| Case | Observed result |
| --- | --- |
| B initialized before A creates a thread | B receives thread metadata/status, but no turn/item stream or dynamic callback until it resumes. |
| Join while dynamic tool waits | Read shows the in-progress turn but omits the pending tool; resume includes its item and replays the same numeric callback ID, plus cumulative usage/settings. |
| Either client responds | Initialized B, even without a thread subscription, answered A's callback successfully. A/C simultaneous answers produced one result; late/losing responses had no JSON-RPC acknowledgment or error. |
| Human question | Resume replays `item/tool/requestUserInput`; the race winner's answer is used, and subscribers receive `serverRequest/resolved`. Status includes `waitingOnUserInput`. |
| Dynamic callback | No `serverRequest/resolved` on success or interruption; use item completion/turn state too. Interruption marks the tool failed, the turn interrupted, and a late answer has no effect. |
| Join during text | B's read and resume omitted the partial agent item. B received only the last 2,211 of 2,291 characters as deltas; full `item/completed` text repaired the 80-character gap. |
| One/all clients leave | One departure did not stop others. All departures while a callback waited retained the active thread; reconnect/resume replayed the same request and it completed. |
| No clients while a command runs | Native work completed. Relay message count stayed 112 for seven seconds with zero connections; history/resume later recovered the finished command, answer and usage. |
| Unsubscribe/restart | `thread/unsubscribe` returned `unsubscribed`; it detached that listener. A separate server restart restored completed history and usage, with no stale pending request. |
| Stale control | `turn/steer` with a stale `expectedTurnId` failed with `-32600` and the actual active ID. |

Representative inspected sequence (IDs shortened):

```json
{"method":"item/tool/call","id":0,"params":{"threadId":"T","turnId":"U","callId":"I","tool":"join_gate","arguments":{"label":"first"}}}
{"id":"C:3","method":"thread/resume","params":{"threadId":"T"}}
{"id":"C:3","result":{"thread":{"id":"T","turns":[{"id":"U","status":"inProgress","items":[{"id":"I","type":"dynamicToolCall","status":"inProgress"}]}]}}}
{"method":"item/tool/call","id":0,"params":{"threadId":"T","turnId":"U","callId":"I","tool":"join_gate","arguments":{"label":"first"}}}
{"id":0,"result":{"success":true,"contentItems":[{"type":"inputText","text":"B answered. Reply FIRST_DONE now."}]}}
```

The example omits unrelated fields and notifications; the native envelopes are
preserved privately. Ordinary client request IDs are connection-scoped; these
server callback IDs are process-global and replay unchanged. **Source-inspected:**
callback removal is atomic and first response wins; user-verification callbacks
have an explicit connection-owner exception. Do not generalize the dynamic/human
result to every authentication callback. [Callback ownership and removal](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/outgoing_message.rs#L566).

For a client, buffer a new connection's events, resume the thread, apply its
snapshot keyed by thread/turn/item ID, then apply the subsequent stream. Treat
complete items as replacements, not appended text. Deduplicate replayed callbacks
by server-instance/request ID and cumulative usage by thread/counter state.
Preserve an explicit incomplete-prefix state during streaming; no global live
replay cursor or text offset repaired the observed gap. A read followed by a
later subscription is not an atomic join. Source serializes running-thread resume
through its listener and subscribes before sending its response, but that does
not make every in-progress item's content available in the snapshot.
[Resume ordering](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L720).

Reproduce from `experiments/` with the absolute parent `.venv/bin/python`:
`uv run --no-project /ABS/ROOT/.venv/bin/python spikes/028-codex-joins/probe.py`,
then `stream_and_control.py` and `direct.py` in the same folder. These are bounded
live calls, exact Luna/low, isolated launcher profiles, existing token reuse in
memory, no source auth changes. A direct native Unix-WebSocket control also
checks pending-request replay without the relay. See [runner, evidence and
limitations](../../spikes/028-codex-joins/README.md), including the shared 032
disconnect/cancellation evidence and offline verifier.

Version: explicit `/Users/nehal/.local/bin/codex`, 0.162.1, SHA-256
`74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0`, macOS arm64,
Python 3.14.7. Inspected source is separately pinned to `6c372fb…`; the installed
release maps to `092d3acd…`, so source findings are not a binary-commit identity
claim. This qualifies ordinary legacy full-history resumes, dynamic tools and
human callbacks; paginated joins, browser rendering, permission races,
user-verification callbacks and arbitrary long outages are not established here.

# Native stream observations and client responsibilities

**Version boundary: Claude Code 2.1.310, observed 25 October 2026.** These are
selected observed messages, not a replacement protocol specification. Original
stdout and stdin are preserved separately in ignored per-process journals.

## Launch, attachment and initialization

The service launches `claude --print --input-format=stream-json
--output-format=stream-json --verbose --include-partial-messages
--replay-user-messages`. It supplies a native session UUID, explicit Haiku model,
an isolated home/config/workspace and the selected credential environment.
Stdin remains open even with zero WebSocket clients. There is no conversation SDK
or model query in the service. Launch and attachment are independent operations.

Initialization is a native client message, not a server handshake:

```json
{"type":"control_request","request_id":"<client-generated-uuid>","request":{"subtype":"initialize","hooks":{},"sdkMcpServers":[]}}
```

The server adds no fields and does not inspect this message. Both attached clients
receive Claude's matching `control_response`, although only one submitted it.
A repeated initialize succeeded in both no-model and active permission checks.
Its outer response included `pending_permission_requests` and
`pending_user_dialog_requests`. The former contained the actual in-flight
permission before an answer, and was empty after the answer.

The SDK's public type declarations document this reconciliation surface and
warn about older CLI versions and inherited pending questions. They also describe
first-attached-client behavior for `supportedDialogKinds` and
`perTaskStopAffordance`. We did not qualify arbitrary initialization changes,
hooks or SDK-hosted MCP ownership. A future client should use one agreed
initialization recipe and treat native capability declarations as versioned
facts, rather than assuming every joining browser can renegotiate everything.

## Prompt acknowledgement is native

The client submits a user message with its own UUID:

```json
{"type":"user","uuid":"<client-generated-uuid>","session_id":"","parent_tool_use_id":null,"message":{"role":"user","content":"..."}}
```

For selected inputs the native output contained:

1. `command_lifecycle` with that `command_uuid`, state `queued`.
2. `command_lifecycle`, state `started`.
3. `user` with the same `uuid` and the submitted content.
4. Assistant/tool output and `result`.
5. `command_lifecycle`, state `completed`.

The second of two concurrently submitted inputs was queued while the first ran,
then started and completed afterward. This is observed native scheduling for the
selected short prompts; it is not a server queue and not a universal promise that
all concurrent input creates distinct turns. Clients need to interpret native
lifecycle and distinguish submitted, queued, started and completed. We did not
qualify steering controls or active interruption in this raw path.

Client IDs must be unique across attached browsers. The service deliberately does
not namespace/rewrite them. The recorded local transport sequence is independent
of native UUIDs. It orders observed chunks, not turns or causal model events.
Each client WebSocket write must contain complete JSONL record(s), including their
newlines. The service serializes whole writes; it does not assemble one client's
partial record across interleaving writes from another client. This is a client
serialization responsibility, not a reason to add a protocol parser to the service.

## One question, multiple possible responders

An explicit native `permissions.ask: ["Bash"]` setting forced a harmless Bash
permission question. Both clients received the same `can_use_tool` request and
native `request_id`. A second initialize listed that same request while pending.
The first client answered allow with the original tool input. Claude emitted:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<native-permission-id>","response":{"behavior":"allow","updatedInput":{"command":"printf CALLBACK_FORCED_068","description":"Print the callback marker string"}}}}
```

That is **native stdout**, not the service copying its stdin journal. The second
client then sent a conflicting deny. The late response did not appear on stdout
and the already-allowed tool completed normally. The next initialize snapshot
reported no pending permissions. A third client replayed the complete stdout and
ended with no pending question by applying the request and then the response.

This check intentionally ordered the second answer after the accepted response;
it does not establish deterministic winner selection for exactly simultaneous
answers or every callback kind. It does establish that no server exclusive-owner
lease or answer arbiter was needed for this selected conflict. Both clients can
learn which **decision** was accepted. There is no native client/browser identity
in this response, so the feed alone cannot say which browser supplied it. A
client's own submitted decision is not evidence that it won.

`control_cancel_request` is also a native type in the public SDK declarations,
including interruption and another-client cases. This successful allowance used
a reflected `control_response` instead. Our first forced-permission harness
incorrectly awaited cancellation and timed out after the successful native result.
Clients should close a pending request on its native response or cancellation,
and reconcile current questions when needed; do not require one outcome shape.
Replaying an old request must only rebuild state, never automatically answer it.

## Failure, interruption and process exit

An unsupported control subtype was forwarded unchanged; Claude returned a native
error carrying the submitted request ID. This demonstrates validation belongs to
Claude, not the relay.

Malformed JSON was also forwarded unchanged. Claude exited with code 1, wrote a
73-byte stderr diagnostic, and emitted no correlated stdout rejection after the
prior initialize response. The service still reports process exit independently
of protocol output. Other clients lose that process too. Client-side input
construction is therefore a real responsibility; a thin server does not make a
bad shared client harmless. No additional server protocol validator is proposed.

An idle native interrupt succeeded from the second client after replay. Active
interrupt/tool termination remains evidence from the older 065 path, not a newly
qualified raw-feed guarantee. The service's explicit stop ended native processes
with exit 143. Journals were flushed before probe cleanup; the browser probe then
explicitly reaped its stopped journal. Graceful termination of the owner cleans
its owned subprocesses. SIGKILL/crash survival was not investigated here.

## Replay transport

Each output envelope carries base64 original bytes, receipt time, byte count and
journal sequence. Attachment receives `replay-start` with the snapshot high-water
mark and output byte/chunk counts, then the captured output, then `replay-end`,
then new output. These are transport markers; they are not Claude records or
acknowledgements. Stdin/stderr journal entries explain gaps in output sequence
numbers. Sequence monotonicity and uniqueness are checked; contiguous output
sequences are not expected.

The snapshot and subscriber registration execute without an await. Each client
has one delivery queue, so output arriving during replay waits behind its
replay-end marker. Native JSONL and UTF-8 may span transport chunks; the client
buffers raw bytes until complete lines before decoding/parsing. A process-exit
marker is enqueued only after its stdout/stderr readers finish, including for a
client that attaches while exit is being observed. Tests cover ten joins during
100 fragmented records and a final 2 MiB record.

Memory retains the complete journal for current-owner replay. A separate writer
persists the same records; it is not awaited before native forwarding or client
enqueue. A stalled writer grew backlog while bytes continued flowing. There are
no payload caps, journal quotas or implicit image removals. Recording errors and
backlogs are exposed; disk-failure recovery, slow-client growth and crash-time
fsync guarantees are not qualified. Persistent files do not imply that a new
owner can recover the old process or pipes.

Native saved transcripts remain under Claude's profile storage. A running-feed
replay, reading saved history, resuming and forking are distinct operations. This
spike tests the first; 064 retains the prior native continuation evidence.

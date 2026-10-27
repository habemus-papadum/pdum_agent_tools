# 071 — The official Claude SDK can join the persistent process, with a client wrapper

**26 October 2026.** We had not previously qualified the combination. 014/016 and
the production launcher established official SDK clients in browser and Node.
068 established independent process lifetime, multiple clients and full replay
using custom clients. That later experiment removed the SDK requirement; it did
not demonstrate that the SDK was incompatible or require copying its internals.

This investigation now verifies selected official-SDK flows against the unchanged
068 owner: shared control, real permission handling, transcript replay, replacement
queries after disconnect, a real browser reload, and recovery of an unanswered
permission. **Reusing the SDK is feasible, but the raw query is not a complete
multi-client/replay client by itself.** Production launchers and the 067 UI still
use their original disconnect policy; no production migration occurred here.

## What the tests establish

| Question | Result with SDK 0.3.296 / Claude Code 2.1.310 |
| --- | --- |
| Can official SDK connections share a process? | Yes. Two browser-export SDK queries under Node initialized and issued controls; both saw the same real tool-permission request. |
| Does SDK close have to kill the process? | No. Closing both connections left the same server-owned PID alive. The Node root SDK also worked through the existing public `spawnClaudeCodeProcess` adapter, whose close detaches its virtual connection. |
| Can a new SDK query read history and continue? | Yes, through a client replay adapter. A real Chrome page replayed the saved conversation, submitted a follow-up and recalled its marker. After injected disconnection and page reload, another query replayed both results and controlled the same process. |
| Can it reconnect while permission is pending? | Yes in the selected case. A replacement query skipped historical callback dispatch; its new initialize response re-armed the same unresolved native permission ID. Answering it completed the actual tool. |
| Does unmodified full replay safely rebuild everything? | No. A credential-free native hook test showed a fresh SDK query executing an already-resolved historical hook callback again. Replaying a callback is active code execution to the SDK. |
| Does the SDK automatically close another client's permission UI? | Not for the observed accepted-response echo. The peer callback's AbortSignal remained un-aborted. The public `awaitControlResponse(requestId)` exposed the native decision; application code then resolved its callback with `null`, suppressing another write. |
| Does the WebSocket query reconnect itself? | No in this pin. Injected socket loss ended iteration; later controls rejected and no reconnect appeared. The tested iterator ended without an error, so the application must retain transport-close evidence. A fresh Query reattached successfully. |

## The proposed division

Keep the server mechanical, as requested: process ownership, unchanged stdin
forwarding, output recording/fan-out and replay boundaries. It contains no SDK
query, acceptance echo, semantic request validator or answer arbiter.

On the client, retain the official SDK for input streaming, controls and supported
callback APIs. Add a small application-owned layer for:

- decoding the replay envelope into the SDK's newline-delimited native messages;
- exposing the complete raw feed and replay progress to the application;
- keeping historical control requests out of the SDK's executable callback path;
- creating a new Query after connection loss, without automatically resending
  uncertain inputs;
- reconciling shared questions using native responses and fresh pending-request
  information, and closing obsolete local UI state.

The tested replay policy retains every original record in the raw client view,
but does not feed historical control request/response/cancellation frames into
the new SDK query. Conversation frames still replay. The query's fresh native
initialization supplies currently pending permissions/dialogs. This qualified
the selected permission path; it is not a complete policy for every hook, MCP
callback or control subtype. SDK `resume` from saved history and replacing a
client attached to a still-running PID are different operations.

The SDK consumes control frames internally rather than yielding all of them as
ordinary conversation messages. Its public `awaitControlResponse` can retrieve
a matching native response, including one already buffered. The `null` callback
result is its public way to suppress a transport write. Its declaration describes
out-of-band response handling; using it after observing a peer's settled decision
worked here and needs a regression when upgrading. The server does not choose the
winning client or manufacture that decision.

## Packaging and ownership qualifications

The Node root export has the public virtual-process hook already used by our
examples. The browser export accepts a WebSocket URL, not a public custom transport
factory. This prototype adapts `globalThis.WebSocket` inside its isolated test
realm, leaving the SDK package unchanged. It also uses the small empty `process`
shim already required by our earlier real-browser checks. Production packaging
should isolate that environment adapter, for example in the SDK's own Worker,
rather than replace an application's general WebSocket behavior. That packaging
choice remains to be qualified; no SDK source patch was needed in this test.

The installed browser export also has SSE cursor/reconnect helpers. Its public
types and implementation describe a hosted CCR event envelope and POST write
contract. Those helpers are not generic reconnect support for our stdio WebSocket
feed. We did not emulate or qualify that hosted service protocol.

Repeated initialization is not neutral for every capability. Public SDK comments
describe hook re-registration and interruption of old pending hooks; SDK-hosted
MCP tools and hooks still execute JavaScript in a particular client. Losing that
client does not preserve its callback code. Shared user-facing permissions worked;
arbitrary callback/tool ownership still needs explicit treatment. This issue also
exists with a custom client and does not justify a server conversation controller.

## Recommendation

Prefer **official SDK plus our client-side attachment/replay layer** for the next
design, preserving raw native messages and official history helpers. Do not fork
the entire SDK or copy its query implementation based on 068. Keep the option of
a small raw client for capabilities the SDK does not expose, with provider-specific
types and evidence retained. Final SDK extraction should qualify the callback
and initialization cases the actual application will use.

## Evidence and limits

The no-model probe used real native callbacks, not simulated provider success.
The live probe used three Haiku inputs: a shared-permission tool turn, a browser
follow-up after replay, and a disconnect/reconnect during another permission.
All completed. Final cumulative native estimate: **USD 0.00126630** (about 0.13
cents), not a subscription invoice or implementation-assistant cost. No paid
retry was made; all experiment-owned processes were stopped.

Two harness assumptions were corrected and retained: the WebSocket iterator did
not throw on the selected close, and pending-request fields live on the native
control-response envelope rather than the SDK's inner initialize return. The
second correction was verified against the captured successful live exchange,
without another model call. Bounds and reproduction are in the [runbook](../../spikes/071-claude-sdk-replay/README.md).

The installed package is the official [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript),
version **0.3.296**; actual worker **2.1.310**, Node **26.10.0**, Chrome **155**.
Package hashes match the earlier 014 investigation. Local exported declarations
and distributed query/transport implementation supplied the detailed API evidence;
no Claude executable internals were reverse-engineered. These results do not
claim compatibility with every future SDK version, arbitrary SDK-hosted tools,
coordinator-crash recovery or seamless continuation of a closed Query object.

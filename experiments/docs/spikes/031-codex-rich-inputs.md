# 031 — Browser images and asset lifetime

**Observed, 2026-10-14:** installed Codex 0.162.1 reports `gpt-6-luna` input
modalities `text,image`. A 16 × 16 solid red PNG succeeds as an inline data URL and
as a server-local path; Luna replies `Red` in both cases. HTTP image URLs are
rejected before a turn starts. A browser can submit image bytes directly in JSON;
it does not need a separate upload service for this form.

The same browser harness as [030](030-codex-remote-operations.md) supplies a file
picker and a canvas-generated red fixture. An automated Chrome 155 check submitted the canvas fixture through the actual
buttons, received `Red`, read history, resumed, disconnected/reconnected and
resumed again with the full user item and answer. It started only one turn.
Evidence: `artifacts/031-codex-rich-inputs/browser-check.json`. A native
browser picker upload was blocked by the automation tool's configured filesystem
roots; that limitation is separate from the data URL protocol.

## Accepted input and retained history

| Form | Observed result | Lifetime/rendering implication |
| --- | --- | --- |
| `image` + `url:"data:image/png;base64,..."` | Completed; assistant `Red`. | Structured user history retains the full data URL after restart, resume and fork. A browser can render it directly. |
| `localImage` + absolute `path` | Completed; assistant `Red`. | App-server reads the host file. Structured history retains its path, even after deletion; a remote browser cannot display those bytes from that path alone. |
| HTTP URL | `-32600`, “remote image URLs are not supported; use an inline data URL instead”. | The server does not fetch this URL or pass it to the provider in the tested input path. |
| Missing local path | Turn completed; assistant `Unknown`; usage was recorded and estimated. | Missing media is not necessarily an RPC failure. Detect omission through diagnostics; do not assume accepted input reached the model intact. |
| `url:123` | Invalid request at deserialization. | Schema rejection is different from a completed turn with omitted media. |
| Malformed PNG bytes | Credential-free probe accepted the turn acknowledgement; no completion was awaited. | Acceptance alone does not qualify image decoding or provider compatibility. |

After deleting the original local PNG and restarting app-server, `thread/read`,
`thread/resume` and `thread/fork` all succeeded and retained the original
`localImage` item. Inspection of **only the experiment-owned** native rollout
found a separate prepared `response_item` containing the PNG data URL, while the
public structured item retained the path. Therefore the UI history view and the
model context representation differ. No new inference after deletion was used to
qualify continued visual reasoning; do not promise that from read/resume alone.

One representative extra input worked: `additionalContext` with
`{probe:{kind:"application",value:"..."}}`. Its rendered developer fragment exists
in the native rollout but not the structured user-message items returned by
`thread/read`. The first attempt used invalid `kind:"text"` and was rejected; the
corrected payload is preserved separately in the attempt ledger.

## Representative wire

```json
{"id":4,"method":"turn/start","params":{"threadId":"THREAD","input":[{"type":"text","text":"What color is this image? Reply one word. Do not use tools."},{"type":"image","url":"data:image/png;base64,PNG_BYTES"}],"model":"gpt-6-luna","effort":"low"}}
{"id":4,"result":{"turn":{"id":"TURN","status":"inProgress"}}}
{"method":"item/completed","params":{"threadId":"THREAD","turnId":"TURN","item":{"type":"userMessage","id":"ITEM","content":[{"type":"text","text":"What color is this image? Reply one word. Do not use tools.","text_elements":[]},{"type":"image","url":"data:image/png;base64,PNG_BYTES","detail":null}]}}}
{"method":"item/agentMessage/delta","params":{"threadId":"THREAD","turnId":"TURN","itemId":"MESSAGE","delta":"Red"}}
```

The reply/notification examples omit unrelated fields. Full private captures retain
exact shapes and bytes; summaries intentionally omit credential/profile contents.

## Reproduce, cost and limits

From `experiments/`, with authorized existing file-backed login:

```sh
node spikes/031-codex-rich-inputs/probe.mjs
# Target just the local-path + additionalContext case:
SPIKE_LOCAL_ONLY=1 node spikes/031-codex-rich-inputs/probe.mjs
```

The runner copies `auth.json` read-only into a disposable home, sets exactly
`gpt-6-luna`, disables tool-seeking in the prompt, bounds turns to 45 seconds and
the run to 240 seconds, and never substitutes a model. No ordinary profile is
modified. Copied authentication files were removed after the runs; the browser
process/listeners and its temporary home were removed after UI checks. Full evidence is under ignored `artifacts/031-codex-rich-inputs/`:
`run-1792000472274/` (initial cases), `run-1792000513897/` (corrected local case),
and `invalid-1792000576100/` (credential-free negative input acknowledgements).
See [detail and ledger](../../spikes/031-codex-rich-inputs/details.md).

Four observed model completions (three CLI, one browser) total **43,276 input**, **37,888 cached input**,
**20 output**, **0 reasoning output**, **0 cache-write input** tokens.
At the coordinator's dated 2026-10-14 Luna Standard rates ($0.10/$0.01/$0.50 per
million uncached input/cached input/output), the API-equivalent estimate is
**$0.00092768** ($0.0006529 CLI + $0.00027478 browser). This is not actual
subscription billing; orchestration agent usage is separate. The browser repeated
the same usage snapshot on resume three times; those repeats are counted once. Rejected requests have no observed usage; zero provider
cost is inferred only for synchronous schema/URL rejections.

**Source-inspected, clean 6c372fb:**
[input variants](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L443)
include text spans, image URL/file ID, local image, audio/local audio, skills and
mentions. [Dynamic tool results](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1684)
accept text and image content. The [image utility](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/utils/image/src/lib.rs#L129)
handles PNG/JPEG/GIF/WebP and can re-encode images; these other formats were not
submitted to the provider here. [Preparation](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/image_preparation.rs)
contains omission placeholders and unsupported-detail handling. This clean source
pin differs from installed 0.162.1; see 025 rather than equating the revisions.

**Unresolved:** text-only-model capability rejection (no model fallback was
attempted), JPEG/GIF/WebP live acceptance, image file IDs/attachment service,
continued visual inference after deleting local assets, audio, skills/mentions,
text spans and dynamic-tool media. Additional context is an observed representative;
the rest remains an inventory, not a tested rich-input SDK.

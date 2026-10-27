# Two-browser transport check

**Observed 25 October 2026; no model inputs, USD 0.** Two real Chrome 155 pages
in separate browser contexts attached to one native Claude 2.1.310 process using
the standard browser WebSocket API. No conversation SDK or shared client memory
was involved. The server started without credentials, using its deliberately
invalid no-model token, and the clients sent only native control requests.

The first browser initialized the process. Both received the native response
with the same request ID. The second browser submitted an unsupported control;
both received Claude's error. Closing both sockets left the same native PID alive,
with zero attached clients. Both then reattached and replayed all 4,437 stdout
bytes. A subsequent idle interrupt generated a native success response: 144 new
bytes after the replay-end marker. Each client had the same final 4,581-byte
stream and SHA-256 digest, with increasing, unique output sequence numbers.

Explicit stop ended the native process with code 143. Each client received one
process-exit marker. After detaching, explicit reap removed the session journal.
The test owner was then stopped; the shared mock server on port 56044 was untouched.
This covers browser transport and replay, not browser handling of model turns,
active-tool cancellation or conflicting permission answers. The other 068 probes
provide their own evidence for those cases.

## Reproduction

From `experiments/`, start a separate server with the repository root interpreter:

```sh
../.venv/bin/python spikes/068-claude-feed-replay/server.py \
  --root artifacts/068-claude-feed-replay/browser-check --host 127.0.0.1 --port 0
```

Open its reported `/sessions` URL in two separate browser contexts. Load
[`browser-check.js`](browser-check.js) into each page through DevTools. These
helpers intentionally expose no model-prompt action.

1. In A, `await feedStudy068.create()`, then `await feedStudy068.attach(id)`.
2. In B, `await feedStudy068.attach(id)` using the same identity.
3. In A, `await feedStudy068.control('initialize')`.
4. In B, `await feedStudy068.control('not_a_native_operation_068')`.
5. Inspect each `feedStudy068.summary()`, then detach both.
6. Verify `await feedStudy068.status()` reports running with zero clients.
7. Attach both again; verify the replay totals, shared responses and sequences.
8. Send `await feedStudy068.control('interrupt')` in B; inspect both summaries.
9. Stop, inspect the exit markers, detach both, and reap through the helper.
10. Send SIGTERM to the test owner identified by the startup output.

Local result: `artifacts/068-claude-feed-replay/root-browser-smoke/report.json`.
The temporary owner PID was 85199 and the native PID was 85769; these are recorded
evidence, not instructions to signal those numbers in future runs. The DevTools
file-loading option rejected this workspace path, so the same checked-in script
was supplied inline through its documented evaluation API. No provider call was
made during that harness correction.

# 027 — History completeness and offline replay

```sh
# From experiments/: two bounded Luna turns, one per storage mode.
node spikes/027-codex-history-replay/probe.mjs --live
# Use the printed artifact directory for offline comparison and local tail tests.
node spikes/027-codex-history-replay/analyze.mjs artifacts/027-codex-history-replay/RUN
node spikes/027-codex-history-replay/tail.mjs artifacts/027-codex-history-replay/RUN
```

`probe.mjs` uses the existing subscription access token only through the native
login RPC, with an isolated profile and working directories. It bounds live work
to two turns, 12 observed tool starts per turn and 240 seconds. The requested model
is always `gpt-6-luna`; no fallback is configured. The fixture asks for a real local
command, stdout/stderr, a real file patch and final text. It saves loaded,
unsubscribed and cold-restart history snapshots, native experiment rollouts, live
wire observations, invocation metadata and usage.

`analyze.mjs` imports only Node filesystem/path/assert helpers. It starts no process,
opens no network connection and requires neither authentication nor an app-server.
It writes a final-item transcript and a live/history comparison under the input
artifact directory. Its real-corpus assertions verify the observed command loss
and idempotent final-item reconstruction when the capture is duplicated.

`tail.mjs` performs only local shell commands through a disposable fork. It checks
in-progress history, cursor direction/anchors, archived reads, and 70,000 bytes of
live command output against native persisted output. It does not submit model turns.

See [result](../../docs/spikes/027-codex-history-replay.md) and
[completeness matrix](../../docs/spikes/027-history-details.md).

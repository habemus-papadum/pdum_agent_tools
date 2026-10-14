# 026 — Session catalogue and administration

Question: which native organization operations work without starting conversation work?

Run from `experiments/` with Node 26.10.0. No package dependencies are required.

```sh
node spikes/026-codex-session-admin/probe.mjs
node spikes/027-codex-history-replay/probe.mjs --live
node spikes/026-codex-session-admin/corpus-probe.mjs artifacts/027-codex-history-replay/RUN --live-cli
node spikes/029-codex-forks/probe.mjs artifacts/027-codex-history-replay/RUN --live
node spikes/026-codex-session-admin/catalogue.mjs artifacts/029-codex-forks/RUN
node spikes/026-codex-session-admin/source-build.mjs artifacts/027-codex-history-replay/RUN
```

Replace `RUN` with the printed artifact directory. `probe.mjs` and `catalogue.mjs`
perform local administration and local shell operations only. `corpus-probe.mjs`
runs one explicitly requested Luna vanilla-CLI turn, sequentially with app-server.
`source-build.mjs` uses the clean source binary prepared by 025, makes an independent
copy of experiment state, removes credentials and rebases native absolute paths.
It invokes the research uv Python environment for this clone repair.

`SPIKE_CODEX_BIN` selects the installed binary for the other entry points. The
default resolves `/Users/OPERATOR/.local/bin/codex` explicitly; every run records
the real path, version and SHA-256 before starting. All output is private under
ignored `artifacts/026-codex-session-admin/`. Normal Codex state is not written.

See [result](../../docs/spikes/026-codex-session-admin.md) and
[detailed observations](../../docs/spikes/026-admin-details.md). The small local
`harness.mjs` is reused by 027/029; it is research scaffolding, not a client SDK.

# Rich input probe

Run from `experiments/`:

```sh
node spikes/031-codex-rich-inputs/probe.mjs
SPIKE_LOCAL_ONLY=1 node spikes/031-codex-rich-inputs/probe.mjs
node spikes/031-codex-rich-inputs/invalid.mjs PATH_TO_GENERATED_RED_PNG
```

The main runner is explicitly credentialed/paid, always uses `gpt-6-luna`, and
copies existing file-backed login into an isolated home. It accepts
`SPIKE_CODEX_BIN` for an explicit binary. The negative runner uses an unauthenticated
disposable home and inspects request acceptance, not successful provider responses.
Use 030's `browser_harness.py --auth` for the minimal browser image submission.
See the [result](../../docs/spikes/031-codex-rich-inputs.md) and [ledger](details.md).

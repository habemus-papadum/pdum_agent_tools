# 029 — Forks, continuation and compaction

```sh
# From experiments/, after generating a 027 corpus:
node spikes/029-codex-forks/probe.mjs artifacts/027-codex-history-replay/RUN --live
```

The runner reuses the experiment-owned profile, not the operator's normal Codex
home. It requests two tiny Luna continuations, one manual compaction, one queued
input and one goal-resume check. **Queue insertion can immediately start inference.**
The goal is bounded to 64 tokens and is paused/interrupted on its first observed
automatic turn. An external 240-second process deadline also applies. These are
probe bounds, not runtime defaults or a guaranteed provider billing ceiling.

Completed, active, boundary and ephemeral forks are inspected. A real local shell
side effect tests whether fork/revert duplicates or undoes filesystem changes.
All native replies, notifications, usage and failures are captured under ignored
`artifacts/029-codex-forks/`. `ledger.json` distinguishes explicit turns from all
observed turn starts, including queue/goal activity and compaction.

See [result](../../docs/spikes/029-codex-forks.md) and
[inheritance details](../../docs/spikes/029-fork-details.md).

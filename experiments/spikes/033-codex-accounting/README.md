# 033 — Offline usage accounting

Run from `experiments/`; no credentials, server or inference are needed:

```sh
uv run --frozen python -m pytest spikes/033-codex-accounting/test_analysis.py -q
uv run --frozen python spikes/033-codex-accounting/analysis.py \
  artifacts/027-codex-history-replay/run-1792000414999/level1.jsonl \
  --out artifacts/033-codex-accounting/history-corpus.json
uv run --frozen python spikes/033-codex-accounting/analysis.py \
  artifacts/028-codex-joins/1792000437132/relay.jsonl \
  --out artifacts/033-codex-accounting/joins.json
uv run --frozen python spikes/033-codex-accounting/analysis.py \
  artifacts/029-codex-forks/run-1792000579846/level1.jsonl \
  --out artifacts/033-codex-accounting/forks.json
```

The named private captures are intentionally untracked. Recreate them using their
respective live runners or pass another capture with the same envelope format.
The tests are self-contained parser/accounting regressions; they are not provider
compatibility evidence. No dependency or public package was added.

The real 034 experiment imports `Analysis` into both a client observer and the
production launcher's processor interface. It compares those snapshots with
offline replay. Its `analyze.py` also reconciles native OTLP and upstream response
usage. Read the [accounting result](../../docs/spikes/033-codex-accounting.md)
before interpreting output: this research implementation deliberately supports
only a stated Luna pricing assumption and surfaces incomplete observations.

# 034 — Observation coverage and shared computation

Run from `experiments/` using the **absolute parent workspace** interpreter,
because the real launcher and MITM packages live there. No research dependency
was merged into those packages:

```sh
uv run --no-project /ABS/PATH/pdum_agent_tools/.venv/bin/python spikes/034-codex-observation/probe.py
```

This is a live probe: exact `gpt-6-luna`, two short user turns and one explicit
compaction, a 180-second external deadline, no model fallback. It reuses the 028
client/probe helpers and the 033 pure analyzer. Existing auth is read into memory;
the ordinary profile is not modified. An isolated profile outside the checkout
is removed afterward. Local raw relay, OTLP and MITM captures are private and
ignored; they can contain credentials and prompts.

The probe runs a local HTTP OTLP/JSON collector, enables native log/trace/metric
export settings, and installs three independent launcher processors: healthy,
100 ms per message, and deliberately failing after two processed messages.
One turn executes a harmless command; another requests a write under an explicit
read-only sandbox. It then compacts the first thread. All client/server and
upstream observations are saved, including loss/backlog status.

Analyze existing evidence without inference:

```sh
uv run --frozen python spikes/034-codex-observation/analyze.py \
  artifacts/034-codex-observation/1792000746266
# Separate credentials-free metrics and exporter-failure experiment:
uv run --frozen python spikes/034-codex-observation/metrics_probe.py
```

The result checks equality of model/count multisets between native OTLP and
unique captured WebSocket completions. It prints derived counts/costs, not raw
payloads. This collector is local; it is not a claim of a Logfire upload.
The [result](../../docs/spikes/034-codex-observation.md) records coverage limits,
native metrics version differences and exporter failure behavior.

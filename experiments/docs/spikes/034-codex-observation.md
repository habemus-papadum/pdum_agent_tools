# 034 — Observation works at several layers

**Observed, 2026-10-14:** the same small analysis ran in a real client, the
production launcher's processor hook, and an offline reader, with identical
results for all 82 captured messages. Native OpenTelemetry adds facts missing
from those client messages. Use both when continuous operational visibility
matters; a passive relay alone observes only traffic passing through it.

## Processing and failure behavior

The real launcher ran a healthy analyzer, a recorder, a processor taking 100 ms
per message, and an exporter that deliberately failed on its third message.
The first model turn completed while the slow processor had **10 pending
messages**. It eventually drained all **82**. The failing processor handled two
messages, reported its exception and **80 lost messages**, while healthy
processors received all 82 and the client completed its work. These are existing
launcher behaviors exercised by the spike, not newly implemented infrastructure.

The private artifacts contain client, processor and replay snapshots with exact
equality assertions. The comparison covers usage increments, final item facts
and status. It does not establish a full transcript renderer or a complete
history-to-health adapter. Native history has missing fields identified in 027;
that adapter must preserve those gaps rather than promise equivalent results.

## Native telemetry adds useful evidence

Explicit OTLP/JSON log and trace exporters sent **50 log records and 2,186 spans**
to a local collector during two Luna turns and one compaction. The log events
included a **sandbox denial missing from structured command items**, and seven
provider completion usage records. Captured upstream WebSocket responses matched
those seven model/count records: four ordinary completions, two warmups and one
compaction. The [accounting report](033-codex-accounting.md) explains their cost
and billing uncertainty.

Selected fields from the observed OTLP log record (the surrounding resource/scope
envelope is omitted):

```json
{"attributes":[{"key":"event.name","value":{"stringValue":"codex.sandbox_outcome"}},{"key":"outcome","value":{"stringValue":"denied"}},{"key":"model","value":{"stringValue":"gpt-6-luna"}}]}
```

This is also noisy: 922 spans were filesystem metadata calls. Preserve detailed
traces where useful, but choose deliberate summary metrics and avoid labels for
every item/message. Native events expose conversation/turn correlation where
available; launcher run/profile identity remains application context. Do not add
costs from OTLP, client messages and upstream traffic as if they were independent
work. No `codex.turn_cost` event was observed in this run despite related source
support.

The first run produced no metric batches. A separate **credential-free** five-case
probe explained why:

| Binary/configuration | Observed metric batches |
| --- | ---: |
| Installed 0.162.1, analytics disabled, custom exporter | 0 |
| Installed 0.162.1, analytics enabled, custom exporter | 4 |
| Clean `6c372fb` build, analytics disabled, custom exporter | 4 |

**Source-inspected:** the [release gates all metrics exporters on analytics](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/otel_init.rs#L70),
whereas the [pinned build gates only Statsig](https://github.com/openai/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/otel_init.rs#L70).
This is a version-dependent configuration interaction, not a reason to silently
enable general analytics in an operator's profile. The emitted metrics covered
process startup, auth storage, SQLite, backfill and home size; model-turn metrics
under this configuration were not separately qualified.

A built-server collector returning HTTP 503 received four attempts. Another
collector delayed replies by 1.5 seconds while 12 administrative requests
overlapped export. Across the five cases the slowest `config/read` took **18.55 ms**.
Every process exited normally; delayed-export shutdown took about **1.51 seconds**.
This establishes responsiveness in a small case, not guaranteed delivery during
an outage or bounded shutdown for every failure mode. Native exporter losses are
not yet reconciled with launcher processor-loss counters.

## Reproduction, Logfire and limits

See [commands and evidence](../../spikes/034-codex-observation/README.md).
Live evidence is under `artifacts/034-codex-observation/1792000746266/`, including
`telemetry-analysis.json`; metrics/failure evidence is under
`metrics-1792001127313/`. Installed release and clean source identities are in 025.
The live profile and owned native/MITM processes were cleaned up; raw captures
remain ignored. The metrics probe uses no credentials or inference.

No Logfire login or project was configured, so **remote Logfire ingestion and
querying remain untested**. The local OTLP result establishes the export path,
not receipt by a particular hosted service. A configured destination is needed
for that final integration check; no telemetry was published externally by this
spike. The Logfire instrumentation skill informed the destination/authentication
check, with no new application dependency.

**Implication:** reuse small pure computations across client and offline tools;
feed launcher processors native observations with provenance. Preserve original
protocol records for later analyzers. Add native telemetry for unattended work,
sandbox outcomes and provider usage; keep optional upstream capture for targeted
verification. 028 proves an unsubscribed relay misses continuing work. An
always-on watcher would need its own lifecycle experiment because `resume` can
activate goal work; do not quietly turn a passive recorder into a controller.

Cross-machine/Linux behavior, durable export under prolonged outages, large
swarms, complete historical health reconstruction, mixed-provider pricing and
Logfire delivery remain open. No production library or plugin was created.

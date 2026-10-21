# 046 — Power-user contracts and source-aligned HP structure

**Result:** the audit identifies **36 contracts** to preserve or deliberately
defer: 8 P0, 26 P1 and 2 P2. The highest-risk distinctions are queue-only mail versus
follow-up tasks, wakeable caller waits, per-turn child completion delivery,
startup steering, answer-boundary admission, interrupted tool/result pairing,
and truthful transport terminal outcomes. The
[full inventory and module mapping](../../spikes/046-hp-power-user-audit/README.md)
record native source/tests, observable behavior, HP evidence, retain/defer/host
decisions and confidence boundaries for every item. The tracked, source-linked
[`feature-matrix.md`](../../spikes/046-hp-power-user-audit/feature-matrix.md)
contains the full readable report, not raw traffic. This is not a claim that all
features have been implemented.

**Updated HP evidence:** 047's final 17 portable control checks pass unchanged in
Node and real Chrome 155; 13 original Node runtime tests also pass. Together with
049's six browser integration scenarios, **23 portable cases pass in Chrome**,
including the final preparation-await cancellation and pre-invocation interrupt
regressions. The final summary is ignored
`artifacts/049-hp-control-integration/browser-controls-final.json`.
Selected live Node mail/steer-wait/interrupt plus
next-turn flows passed with six responses, and actual browser 045 model-selected
delegation passed a separate six-response recheck. Only the corresponding rows
were upgraded; native jobs, parallel scheduling, goals, human request brokers
and broad API compatibility remain unqualified.

**Native reference:** clean Codex source
`6c372fbef45f730b6d8aa727b0ec8332365588db`, with GPT-6 multi-agent v2.
[`send_message`](https://github.com/habemus-papadum/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs)
queues without waking idle work;
[`followup_task`](https://github.com/habemus-papadum/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/tools/handlers/multi_agents_v2/followup_task.rs)
uses the same path with TriggerTurn. V2
[`wait_agent`](https://github.com/habemus-papadum/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)
takes timeout only, watches caller mailbox/steer activity and does not return the
child's answer. Parent results arrive through separate best-effort completion
mail on each child turn. These distinctions were sent directly to the 047
runtime owner before its control refactor.

The completed assistant item establishes the
[mailbox answer boundary](https://github.com/habemus-papadum/codex/blob/6c372fbef45f730b6d8aa727b0ec8332365588db/codex-rs/core/src/stream_events_utils.rs#L96),
with an exception for explicit same-turn input already pending. Untagged
nonempty assistant output defaults to final; commentary does not close delivery.
Turn completion, mailbox delivery and provider response completion therefore
need separate state. The mapped design keeps session admission/turn execution,
agent control/mailboxes, captured step/tool dispatch, context/history and host
resource ownership distinct in shared browser/Node code.

**A retained host contract:** native unified-exec tests show yielded sessions
surviving turn interrupt, managed one-shots being terminated, and non-PTY
Ctrl-C translated into SIGINT behavior. 042 currently kills its processes on the
originating turn's signal and passes raw `0x03` through pipes: explicit
deviations requiring a job/lifetime registry and receipts, not a small cleanup
toggle. A credential-free probe observed installed **Codex 0.163.0 app-server
command/exec pipes** also treating raw `0x03` as data and needing explicit
termination. That endpoint is a lower layer, **not** a unified-exec tool oracle;
its observation is reported separately from pinned source-test contracts.

**Reproduce / evidence:** from `experiments/`, run
`node spikes/046-hp-power-user-audit/audit.mjs --write-doc` and optionally
`node --import tsx spikes/046-hp-power-user-audit/lifetime-probe.mjs`.
The first verifies citation anchors and fingerprints files; it does **not** run
the referenced tests or prove parity. Ignored `artifacts/046-hp-power-user-audit/`
contains linked matrix/JSON copies and the actual lifetime-probe result;
`--write-doc` also regenerates the tracked safe source report.
The probe uses disposable `HOME`, `CODEX_HOME`, files and owned processes.
Environment: 2026-10-18, macOS arm64, Node 26.10.0, pnpm 11.9.0. No native builds,
provider requests or paid spend occurred.

**Remaining gates:** tool eligibility/concurrency, native job polling/watchers,
clock/reminders, automatic context triggers, historical fork/rollback/recovery,
goals, dynamic tool/skill/MCP discovery and elicitation, human questions/optional
approvals, real images, context meters and observer backlog/loss. Existing
041/042/043/045 evidence qualifies selected pieces only. Broad native CLI
compatibility and a complete code-mode runtime remain unclaimed.

User queued submissions are an explicit separate row: native
`thread/queue/add/list/delete`, update/reorder/start are not agent mailbox notes,
follow-up tasks or active steering. HP does not implement these APIs yet. Two
further rows retain multi-client join/subscription/pending-request replay and
competing-answer arbitration, carrying forward the earlier 025–034 client work.
HP's two-client listener test does not qualify native resume replay or a
server-request broker.

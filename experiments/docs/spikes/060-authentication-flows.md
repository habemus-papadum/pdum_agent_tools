# 060 — Authentication ownership and outcomes

**19 October 2026 · Round A · interaction simulation.** The question was whether a
compact authentication view could make provider, profile, host and credential
location explicit while using the existing launcher operations. The runnable
study is `/060-authentication-flows/` (alias `/auth/`) in the
[shared mock lab](../../spikes/055-orchestrator-mock-lab/README.md).

The study offers Codex/Claude, local/remote hosts and API-reference, existing-login
reuse and dedicated-native-login fixtures. Its operation preview expands real
CLI names and flags into explicit synthetic paths. Setup provenance stays behind
a disclosure; the current host-local operation and result owner stay visible.
The [operation map](../../spikes/060-authentication-flows/README.md#configuration-and-operation-map)
links each choice to the existing Python library, CLI and native fields.

Source inspection found two differences the UI must preserve. Codex reuse copies
`auth.json` during profile creation; it is not a reusable `auth configure` method.
Claude borrows an access token and does not manage its refresh. Claude’s current
CLI exposes creation choices, native login and status, without an existing-profile
auth configuration interview. The mock therefore selects explicit prepared
profiles and labels creation commands as provenance with an absent-target
precondition. It does not invent a second durable configuration scheme.

A simulated attempt freezes provider/profile/host, so later selection changes do
not silently retarget it. Native response, authentication evidence and model
access are separate. Codex status remains configuration evidence with authentication
unchecked; Claude native status remains an upstream claim, not proof of model
access. A synthetic access denial can follow a successful status observation.
Cancellation of a local fixture differs from stopping observation of a remote
fixture: the latter leaves an unknown host outcome. Expiry, failure and connection
loss have explicit terminal states and no automatic replay. These acceptance
cases carry [RC-07 and RC-08](../../../docs/runtime-contracts.md) without claiming
new real-provider behavior.

The implementation follows pure model → durable scoped controls/actions →
disposable cells → Solid components. It consumes source-linked HP design tokens
and source tooling, and reuses the shared command palette. The toolkit namespace
is `orchestrator-auth`; both cells and all controls/actions are source-stamped.
The provider-capable dock is intentionally absent from this authentication study.
Component and graph hot edits retained a frozen active receipt in the real page.

Reproduce from `experiments/` with
`node spikes/055-orchestrator-mock-lab/serve.mjs`; open the printed URL at `/auth/`.
Run the two colocated Vitest suites via the shared lab, then invoke
`runAuthBrowserChecks()` from `auth.browser-check.mjs` in the live page. On 19
October, shared TypeScript checking, 15 pure/graph tests and 41 browser/tool checks passed, including all 12
provider/host/strategy combinations. Native launcher `--help` confirmed the shown
Codex configure and Claude create flags. Separate keyboard, HMR and viewport
checks cover the interaction; 360/390/414 CSS-pixel layouts had no horizontal
overflow, and 1440 CSS pixels was inspected separately. The final clean browser
run had no console warnings/errors. One rapid viewport/reset loop produced an
8.1 ms Solid development scope-time warning, recorded in the README. The
coordinating host owns the combined build.

Environment: source checkout based on `470d04e` with uncommitted Round A work;
Node 26.10.0, pnpm 11.9.0, Vitest 5.0.3, source-linked AIUI at `1de1c853`, and
`solid-js` / `@solidjs/web` 2.0.0-rc.13. These are implementation/interaction checks, not upstream login
compatibility tests. No credentials were read, profile state written, browser
login opened, worker launched or provider called. Model usage and estimated
inference spend: **0 / USD 0**.

Remote completion, reconciliation, cancellation and refresh remain proposals or
unqualified paths. Profile configuration work belongs to Round B/063; actual
remote/native login qualification is needed before live control. Round A review
should judge whether ownership and evidence are easy to see, and whether the
compact source-linked preview teaches the important provider differences. The
ownership strip and separated evidence receipt are possible reuse candidates;
no upstream framework or production launcher edits were made.

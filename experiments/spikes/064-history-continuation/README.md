# History into continuation

**25 October 2026 — closing study integrated into the working 067 page.**
Open `http://localhost:56044/session-lab/`, then **Saved sessions**. This is a real
native catalogue and continuation flow, not a separate synthetic mock.

1. Pick Codex or Claude history and inspect an owned lab conversation. The current
   live conversation and draft stay unchanged.
2. Choose **Resume latest**, or **Fork from a point** and an explicit native
   boundary. Codex points are turns; the Claude UI offers assistant-message
   boundaries without an unfinished tool-use block.
3. End this page's existing runtime if one is still controlled. Open the selected
   continuation in its source profile and recorded working directory.
4. Read its saved baseline, edit the retained draft and press **Send new turn**.
   Opening a continuation never automatically sends the draft.
5. Read the resulting native history and explicitly end the runtime.

The user explicitly narrowed these studies to our launcher-owned lab profiles.
There is no discovery or adoption of the developer's ordinary running agents.
Continuing a conversation does not restore files, tools or old process handles.

## Existing operations and local code

The extension lives in `../067-live-session-workspace/`: `backend.py` adds native
catalogue/read operations and validates continuation references; browser
`controller.ts` performs Codex resume/fork RPC and uses the official Claude SDK;
`continuation.ts` supplies saved baseline plus new live projection; UI controls
and cells keep inspection separate from continuation. See [backend notes](backend-notes.md).

The native history endpoints are `GET /history?provider=...` and
`GET /history/{provider}/{sessionId}?cwd=...` under the preview's
`/__session-lab/` prefix. They never call resume/fork. Explicit `POST /sessions`
accepts a continuation description. Codex conversation creation/continuation stays
in the browser's native client; Claude forking uses the existing official history
helper before allocating a resume worker. These disposable envelopes are evidence
for the architecture proposal, not a new public SDK.

Data stays in the existing ignored 067 lab profiles. Native history reads do not
depend on `live.json` debug captures. Claude lists its base working directory and
working directories recorded by this lab; it does not claim complete discovery
of sessions in unrelated directories. Old run metadata is observation evidence,
never permission to adopt a prior owner's runtime.

## Measured results

Real Luna/Haiku browser runs retained original IDs on resume and produced new IDs
on fork. Both forks cut before the later continuation-only code, preserved source
message content and recalled the original sample marker. Baseline and new live
content rendered together with their source labels. Draft preservation and zero
client submissions before explicit Send were inspected.

Eight new real no-model backend checks passed, alongside the original eight
startup/cleanup checks. Ten read-only browser checks and desktop/390-pixel layouts
qualified the UI interactions. Provider/version limitations and architecture
implications are in the [report](../../docs/spikes/064-history-continuation.md).

From the repository root, the no-inference check is:

```sh
.venv/bin/python experiments/spikes/064-history-continuation/backend_check.py
```

It uses isolated copies of previously selected native evidence and public provider
operations, with fake credentials and no model prompts. Follow its arguments and
the backend notes for source selection; a fresh checkout does not include private
history artifacts. `collect_costs.py` re-derives only the selected paid round's
estimates from ignored client captures and submits no provider requests.

Raw evidence: `experiments/artifacts/064-history-continuation/browser-evidence.json`,
`costs.json`, and the corresponding 067 `runs/<id>/` directories. All credentials
and native data remain ignored. The [usage ledger](usage-ledger.md) includes both
064 and 065; no implementation-agent costs or subscription bill were measured.

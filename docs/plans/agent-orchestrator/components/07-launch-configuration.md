# O07 — Launch and working configuration

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Start a new agent or session from a chosen host, provider, profile, working directory, prompt and run-specific settings. Make the effective configuration understandable before submission.

## Existing foundation

Existing [Codex](../../../specs/codex-launcher.md) and [Claude](../../../specs/claude-launcher.md) launchers own native processes. HP launch/host composition is research. Browser launch orchestration is proposed.

## Proposed boundary

Preview/cancel does not mutate profiles or launch work. Separate a process launch, conversation creation and a new turn. An accepted launch request is not proof of ready/authenticated/model-running state; unknown outcomes need inspection before retry.

**Inputs and outputs:** Host/profile/workspace choices and per-run overrides → a launch record and addressable session, with effective settings/provenance.

[O21](21-host-coordinator.md) composes the launcher libraries and returns the
provider connection description. The session SDK then handles conversation
operations; a process endpoint need not already contain a conversation. Reconcile
a lost launch acknowledgement before launching a duplicate. An explicit or
policy-enabled recovery operation may construct a new launch from retained
history, preserving its lineage and uncertainty.

## Candidate progression

- **Mock:** A launch panel with inherited defaults, overrides, working-directory choice and launch progress/failure.
- **First usable slice:** Launch through one existing owner and open the resulting session; preserve a recoverable view of partial failure.
- **Later:** Saved launch templates, batches, environment choices and targeted model/effort/service overrides, without silently persisting them into the source profile.

These are discussion candidates, not scheduled work or implemented capabilities.

## Recorded review — 26 October 2026

Use the context where the launch action occurred to seed host, project and cwd;
make the origin visible and let the user review/override. Conversation working
model/effort/tier choices carry into the next turn, never silently into saved
profile/application defaults. Saving those defaults has its own explicit action.

Include existing-directory/worktree versus requested new-worktree intent. Prefer
the selected provider's supported native launch option or an existing provisioner;
qualify the actual headless/app-server route before claiming creation support.
Do not build a worktree manager merely to expose the option. Record the resolved
cwd and keep filesystem branching distinct from conversation forks.

Offer longer Codex unload timing in creation, labelled with its actual shared
server-start scope. No host keepalive subscription is wanted. See
[D2/D3](../system/decisions.md) and [RC-06](../../../runtime-contracts.md#rc-06-idle-delay-is-native-server-configuration).

## Your additions

- Should launch live in a quick drawer, a dedicated page, or both?
- Which choices should be remembered between launches, and which should always be explicit?

Additional requirements, examples and decisions: **TBD with you.**

# O06 — Profiles and authentication

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Create, inspect and edit profiles, choose their authentication strategy, and complete login or credential refresh from a coherent browser workflow.

## Existing foundation

Reuse [profile setup](../../../profiles.md) and [Claude profile isolation](../../../claude-profile-isolation.md). API keys, explicit login reuse and dedicated native Claude login have existing paths; broader providers and renewal retain qualification gates.

## Proposed boundary

A profile can serve several runs. Native config remains native, including fields the UI does not understand. Show profile defaults separately from run/turn overrides. Host-native login may require operator interaction; the browser should coordinate and show outcomes rather than become a second credential store by accident.

**Inputs and outputs:** Profile metadata/configuration and auth operations → configured profile identity, effective defaults and authentication readiness.

## Candidate progression

- **Mock:** Profile list, create/edit flow, authentication states and a cancelled login with no accidental profile mutation.
- **First usable slice:** Adapt existing create/config/read/login operations for one host, including the already-supported credential strategies.
- **Later:** Add supported federation, Bedrock and other provider choices; qualify refresh/concurrency across sessions sharing credentials.

These are discussion candidates, not scheduled work or implemented capabilities.

## Recorded review — 26 October 2026

Keep credential changes simple and independent across sessions. The selected
native login/reference operation proceeds without pausing/draining other work,
cross-session leases or a busy-profile guard. Existing sessions follow native
credential behavior and may fail naturally; expose their messages rather than
adding protective coordination. More elaborate renewal/login logic can be added
after experience demonstrates a need. Status remains evidence rather than a
mandatory model-validation gate. See [D7](../system/decisions.md).

## Your additions

### Recorded follow-up — 25 October 2026

The user proposed generating a long-lived Claude subscription token with the
public `claude setup-token` command and supplying it to a new profile, potentially
on another host. [Spike 066](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/066-claude-setup-token.md)
qualifies that flow using the existing per-worker environment hook, with separate
profile state and explicit credential references. No production auth strategy has
been added. No-model SDK/profile-isolation checks passed. After an initial token
was rejected and the terminal input was repaired, a replacement passed all 11
live checks: successful Haiku replies, rejection of an invalid replacement,
continued operation of an existing worker and successful use by a fresh worker
after restoration. Total native reported estimate: USD 0.000219. Remote transfer,
actual revocation, renewal and production credential-reference design remain open.

The operator has no Codex Business/Enterprise account. Do not schedule a Codex
workspace-access-token spike for this operator. Existing Codex native-login/API-key
choices remain the applicable paths.

Keep setup-token acquisition separate from profile configuration copying. Native
Claude login remains useful for features a setup token cannot authorize, including
Remote Control. RC-11 records why an auth-status badge is not model validation.

- Which profile fields belong in a concise setup flow versus an advanced native-config view?
- How should login/reuse/refresh be presented, including transitions requiring a host or browser login step?

Additional requirements, examples and decisions: **TBD with you.**

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

## Your additions

- Which profile fields belong in a concise setup flow versus an advanced native-config view?
- How should login/reuse/refresh be presented, including transitions requiring a host or browser login step?

Additional requirements, examples and decisions: **TBD with you.**

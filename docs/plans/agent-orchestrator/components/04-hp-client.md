# O04 — HP client and Node/browser hosts

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Expose one HP agent implementation through browser- and Node-usable client APIs. Make its host and tool capabilities clear without creating separate agent semantics for each environment.

## Existing foundation

The [HP findings](../../../hp-agent-findings.md), [parity pass](../../../hp-agent-parity.md) and [work integration](../../../hp-agent-work.md) describe the shared research core and actual Node/Chrome checks.

## Proposed boundary

A subagent is another async agent execution, not inherently an OS subprocess. Browser-owned agents depend on their page/Worker host lifetime. Native files/processes require a Node or remote adapter. The research protocol implements selected Codex shapes plus explicit HP extensions, not full compatibility.

**Inputs and outputs:** An injected transport/runtime owner and host tool set → threads, turns, child control, jobs and retained observations.

## Candidate progression

- **Mock:** A browser-session-local facilitation/test agent alongside a Node-hosted agent, with different tool sets and clearly different ownership; no remote administration of the browser agent.
- **First usable slice:** Extract only the client/runtime boundary needed by a real session view, and run its public client code in Node and Chrome.
- **Later:** Add reusable host services, richer tool discovery and deliberately scoped persistence; keep cross-provider delegation separate from HP-native spawning.

These are discussion candidates, not scheduled work or implemented capabilities.

## Recorded review — 19 October 2026

Initially, browser HP agents run inside the overview application to test local
facilitation and later reusable AIUI components. They belong to that browser
session, use a smaller application-supplied tool set, and are not administered by
the remote host coordinator. Do not implicitly share them across tabs or grant
native filesystem/process tools.

Node HP remains a host-managed runtime. Browser model/credential connectivity
and optional session-log export do not make the browser runtime remotely owned.
Local history is the starting recovery direction; reload behaviour and any
future same-browser coordination still need discussion before implementation.
Do not infer an account-wide or machine-wide browser-agent identity.

## Storage and continuation evidence — 25 October 2026

The user explicitly requires storage independence from filesystem versus browser
technology. [070](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/experiments/docs/spikes/070-hp-backend-parity.md)
now runs the same archive/restore/fork logic with filesystem and IndexedDB
adapters. Actual Luna context survives Node process exit and browser page/Worker
reload; history reads remain passive and old tool calls are not repeated. A fork
selects an exact completed checkpoint, preserving source history and opaque
compaction context. Pending mail/jobs stay historical evidence, not restored work.

Existing history writer and TypeScript/SQL pricing agree on real Node/browser
archives, including child/fork attribution. Schema v5 already accepts the rows;
one out-of-turn compaction invariant and pure-pricing module separation need
production follow-up. Keep persistence, host bindings and analytical ingestion
separate. This qualifies research helpers, not a production management protocol,
automatic save policy, cross-tab execution host or seamless recovery. See [RC-14](../../../runtime-contracts.md#rc-14-hp-history-restores-context-through-host-independent-storage).

## Initial persistence policy — 26 October 2026

The user delegates the initial recommendation: portable storage, committed
completed checkpoints and explicit fresh-owner restore, with no automatic replay
of unfinished tools, jobs or pending mail. [D5](../system/decisions.md#initial-hp-persistence-policy-delegated-engineering-recommendation)
records boundary-triggered asynchronous saves, visible commit failures and the
limits of orderly versus abrupt shutdown. Broader cross-tab execution and
durability guarantees remain separate later choices.

## Your additions

- Where should locally hosted browser agents appear in the host/agent overview?
For now, as we're moving along this project, the locally hosted browser agents would be things that are running in the Overview application itself. It's a very strange application in a sense. It's mostly for testing for now. What will happen is that locally hosted browser agents shouldn't be actually administered by a remote orchestrator. They're really meant to be only for that specific browser session, not connected to a server, not shared across multiple browser tabs, etc. They're meant for very quick user facilitation, but to test that, what we can have is browser-based agents that run in the host UI that we're creating, just for the purposes of testing that interaction. That makes sense.

I think this is something that would be important to understand: those agents would have much fewer tool calls. They wouldn't be able to hit the file system, etc. They'd be sort of geared towards a static website, but it's useful to have them running in the host application just as a way of testing out the functionality. Eventually, what will happen is that bits and pieces of the host UI will be taken out and made standalone and be easy to integrate into AI UI apps, and there they would run various agents. In the browser

- What should happen when navigating away, reloading the page or closing the app?
In general, we should try to just rely on local history alone and then just do the best thing possible, but it's unclear. What do you do when you have two tabs open on the same website, and how do you distinguish? How do you want that behavior to work?

It's unclear, but the browser-based tabs are meant to be not connected to a central server, except for maybe storing their session logs and so forth. The way I'd say it is, if you think about how WebRTC is meant to work in our infrastructure, it's really meant to be peer-to-peer. Here, the idea is that the agent is very much tied to specific browser tabs, session, or maybe a specific browser, and coordinated across tabs. I'm not sure, but at most, that is not user-based or host-session-based or what have you. Again, we still need to work out the details, though.

Additional requirements, examples and decisions: **TBD with you.**

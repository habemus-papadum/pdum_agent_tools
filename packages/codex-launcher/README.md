# habemus-papadum-codex-launcher

Python import: `pdum.codex_launcher`.

## Purpose and status

The intended package manages named profiles for Codex instances and launches
app-server using a selected profile. A profile is expected to select the model,
parameters, upstream authentication method, and preferred Codex executable.

**This package is currently an empty scaffold.** Profile schemas, persistence,
credential handling, process lifecycle, and public interfaces are being explored in
the [architecture proposal](https://habemus-papadum.github.io/pdum_agent_tools/specs/codex-launcher/)
and are not finalized or implemented. There are no runtime dependencies, APIs, or CLI entry
points. No Codex executable is bundled or installed by this package.

The [implementation plan](https://habemus-papadum.github.io/pdum_agent_tools/plans/codex-launcher/)
defines staged work and validation gates, not completed implementation.

## Development

The agreed [operating stance](https://habemus-papadum.github.io/pdum_agent_tools/design-principles/)
is trusted-network use: no sandbox/approval prompts by default, all-interface TCP
listeners, easy profile/credential copying, and no mandatory client grants or
connection-expiry timers. Native Codex configuration stays native. A lockdown
mode is deferred; collision prevention and reliable cleanup remain core hygiene.
Launch stays foreground/application-owned and records process identity for cleanup.
MITM is absent by default. The thin relay supports asynchronous inspection and
metric/export hooks without gating forwarding. A mountable Typer CLI is planned;
daemon mode and remote profile migration are not part of the initial delivery.

Work from the repository root:

```sh
./scripts/setup.sh
uv run --frozen --all-packages python -c "import pdum.codex_launcher"
uv build --package habemus-papadum-codex-launcher
```

Source belongs in `packages/codex-launcher/src/pdum/codex_launcher/` and tests in
`packages/codex-launcher/tests/`. Do not add `src/pdum/__init__.py`: `pdum` is a
shared namespace. There are no tests yet.

Use the shared [development guide](https://habemus-papadum.github.io/pdum_agent_tools/development/)
and [agent instructions](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/AGENTS.md).
Development and tests must not modify the developer's normal Codex configuration,
credentials, or sessions.

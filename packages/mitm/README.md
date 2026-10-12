# habemus-papadum-mitm

Python import: `pdum.mitm`.

## Purpose and status

The intended package launches a man-in-the-middle (MITM) proxy as a sidecar and
records traffic. It is general-purpose infrastructure, not an AI-agent integration.
Extension points for provider-specific functionality are part of the intended
scope, with proposed interfaces awaiting review.

**This package is currently an empty scaffold.** It has no runtime dependencies,
public API, CLI, proxy implementation, or recording format. The
[architecture proposal](https://habemus-papadum.github.io/pdum_agent_tools/specs/mitm/)
recommends the intended behavior and interfaces; it does not finalize them.

The [implementation plan](https://habemus-papadum.github.io/pdum_agent_tools/plans/mitm/)
defines staged work and validation gates, not completed implementation.

## Development

The agreed [operating stance](https://habemus-papadum.github.io/pdum_agent_tools/design-principles/)
trusts the operator's network, consumers, plugins and configured sinks. TCP binds
default to all interfaces; enabled capture preserves useful payloads without
mandatory redaction or export gates. Recording uses a separate observation path,
with no initial payload caps or run quotas; monitor backlog, storage and failures.
Explicit processor hooks, simple file/test processors and a reusable Typer CLI
are planned. Keep clear lifecycle ownership and raw captures out of Git/public CI.

Work from the repository root:

```sh
./scripts/setup.sh
uv run --frozen --all-packages python -c "import pdum.mitm"
uv build --package habemus-papadum-mitm
```

Source belongs in `packages/mitm/src/pdum/mitm/` and tests in
`packages/mitm/tests/`. Do not add `src/pdum/__init__.py`: `pdum` is a shared
namespace. There are no tests yet.

Use the shared [development guide](https://habemus-papadum.github.io/pdum_agent_tools/development/)
and [agent instructions](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/AGENTS.md).
Keep captures and any authentication material private and outside committed files.

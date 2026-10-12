# habemus-papadum-codex-launcher

Import: `pdum.codex_launcher`. CLI: `pdum-codex`.

Self-contained Codex profiles, async foreground app-server ownership, PID-aware
cleanup, a thin browser-compatible WebSocket relay, inspection processors and
optional upstream MITM. Uses your selected installed Codex; no binary is bundled.

```sh
uv run pdum-codex launch --temp --model gpt-6-luna
```

Connect the ordinary CLI using `codex --remote ENDPOINT`, with the printed
endpoint. Temporary profiles can snapshot available file-backed credentials with
a warning; submitting prompts can incur model usage. Default operation trusts
the operator's network: sandbox/approvals off and all-interface TCP listeners.

Persistent profiles:

```sh
uv run pdum-codex profile create research --model gpt-6-luna
uv run pdum-codex --profile research profile configure
uv run pdum-codex --profile research auth login
uv run pdum-codex --profile research launch
uv run pdum-codex --profile research status
uv run pdum-codex --profile research stop
```

On a terminal, create/configure use Rich previews and Questionary selections.
New profiles default to importing your native Codex home; use `--clean` for fresh
settings or `--no-interview` for scripts. Select all/none/individual marketplaces,
plugins, MCP servers and skills, then accept or edit the remaining native TOML.
Imports are experimental and preserve unknown settings. Configure starts from
that profile, not your ordinary developer configuration.

Authentication can preserve native settings, use ChatGPT login, refer to an API-key
environment variable, or use AWS → OpenAI API federation. Configuration and login
are separate, with `--login` for a post-save login action. The `federation` extra
adds the exchange dependency; live AWS mapping/login/renewal qualification remains
pending. See the [profile guide](https://habemus-papadum.github.io/pdum_agent_tools/profiles/).

The Python API accepts a directory. `async with launch(directory, LaunchOptions(...))`
owns the process and yields its endpoint, PID and async status/stop operations.
`pdum.codex_launcher.cli.create_app()` returns a mountable Typer command tree.

MITM is absent by default. Install the `mitm` extra and use
`--mitm --capture-dir PATH --capture` to record upstream traffic, or omit
`--capture` and toggle it later with `capture on/off`.
`--record NEW_FILE` records the independent client-protocol stream.
`JsonlRecorder`, `UsageObserver` and explicit processors run independently
of forwarding; missing usage stays unknown and repeated totals are not summed.

The `management` extra provides `pdum.codex_launcher.management.create_app(server)`
for optional FastAPI status/capture/stop routes over the existing process owner.
It neither starts another server process nor adds a second lifecycle.

The first implementation passes real local tests and a small live Luna turn through
the vanilla remote CLI, relay and MITM. See [current capabilities and limitations](https://habemus-papadum.github.io/pdum_agent_tools/implementation-status/)
and the [testing guide](https://habemus-papadum.github.io/pdum_agent_tools/testing/).
The wider [architecture](https://habemus-papadum.github.io/pdum_agent_tools/specs/codex-launcher/)
includes further unimplemented conveniences and unqualified federation renewal;
it is not a promise that every proposed feature ships now.

From the repository root:

```sh
./scripts/setup.sh
uv run --frozen pytest packages/codex-launcher/tests
uv build --package habemus-papadum-codex-launcher
```

Follow [AGENTS.md](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/AGENTS.md).
Never commit profiles/captures or modify the operator's ordinary Codex state in tests.

# First working implementation

The repository now has a tested local implementation, not just scaffolds. The
architecture documents remain the broader target; they are not a claim that every
planned option is available. This page records the implemented boundary.

## Claude launcher

The new, unreleased `pdum.claude_launcher` package implements profile creation,
API-key references, existing-login reuse and native dedicated-profile login commands;
an async foreground manager with lazy native workers; raw SDK relaying; official
Python SDK history helpers; a mountable Typer CLI and optional FastAPI management
adapter; asynchronous protocol recording/usage and optional generic MITM composition.

Real Node SDK control, callback, inference, concurrent workers, fork/resume and cleanup
passed against the Python implementation, including one captured upstream streaming
response through MITM. Dedicated-profile native login and a subsequent live turn
also passed. Actual Chrome/API-key checks passed streaming inference, concurrent
workers, client-owned hooks, saved history, fork/resume recall and cleanup against
this Python host. See the [guide](claude.md), [qualification report](claude-validation.md)
and [delivery plan](plans/claude-launcher.md) for evidence and limitations.

Native tests also establish [profile customization isolation](claude-profile-isolation.md),
and a credential-free Node check passes four concurrent clients across two rounds.
The browser example includes a basic profile/history/chat workflow; visible controls
passed live chat, history, rename, resume/fork initialization, profile switching and
tab-close cleanup. Mid-turn UI interruption and interactive permission controls
remain unqualified. A pinned Linux compatibility CI job is prepared but has not run.
The [Claude checkpoint and follow-up](claude-handoff.md) records the stopping point
and priorities for resuming work.

## Codex launcher

The separate [Codex client feasibility round](codex-client-findings.md) now
qualifies native history/admin, multiple-client, remote-tool and observation
behavior. Its proposed client/analysis layers remain research, not additional
public APIs implemented by this launcher.
The [client API design](specs/codex-client.md) and
[delivery plan](plans/codex-client.md) await review before a TypeScript package is built.

- Async directory-based profiles, atomic creation and source copying, unknown
  native TOML preservation, executable selection and clean/inherited environments.
- Temporary profiles with convenient warning-based file-auth snapshots; native
  ChatGPT login command and API-key environment-reference setup.
- Rich/Questionary create/configure interview, all/none/individual native imports,
  pager/editor for unrepresented TOML, preview/diff and stopped-profile save/rollback.
- Selectable ChatGPT/API-key/AWS federation setup and separate login actions.
  AWS helpers are accepted by native Codex; actual cloud exchange/renewal is unqualified.
- One app-server owner per profile using an inherited file lease, PID/birth-identity
  journal, readiness, live status/stop and verified orphan recovery.
- Foreground CLI or async context lifetime; native Unix backend and optional
  browser-compatible all-interface WebSocket relay. `--direct` exposes the native
  Unix endpoint instead. No daemon or attachment convenience.
- Independent message processors, JSONL recording, read-only usage snapshots,
  explicit processor selection/discovery and exported Typer app/factory.
- Optional managed MITM launch, capture status/on/off controls, and shutdown of
  Codex if the proxy itself fails. Recording-only failures do not stop forwarding.

```sh
uv run pdum-codex launch --temp --model gpt-6-luna
uv run pdum-codex --profile research profile create --model gpt-6-luna
uv run pdum-codex --profile research auth login-chatgpt
uv run pdum-codex --profile research launch --mitm \
  --capture-dir artifacts/upstream --capture --record artifacts/client.jsonl
```

Use the printed endpoint with vanilla `codex --remote ws://HOST:PORT`. Use a
connectable host/IP from another machine, not the wildcard bind address. Run the
foreground launcher in tmux or a container if desired. From another terminal:

```sh
uv run pdum-codex --profile research status
uv run pdum-codex --profile research capture off
uv run pdum-codex --profile research capture on
uv run pdum-codex --profile research stop
```

Native configuration remains in `<profile>/codex/config.toml`; launcher metadata
is `<profile>/launcher.toml`. The interactive interview defaults to the ordinary
native home for new profiles and the profile itself for configuration. Explicit
source directories, clean creation and noninteractive flags are supported.
See [profile setup and authentication](profiles.md) for commands and import limits.
Capture destinations must be selected at launch, and the JSONL relay recorder
refuses to overwrite an existing file.

## MITM

`pdum.mitm` runs a pinned mitmproxy 12.2.3 child with its own CA/config directory.
It provides a scoped environment overlay, real HTTP(S) streaming and bidirectional
WebSocket messages, recording off/on on existing intercepted connections, complete
payloads, file archives/manifests, explicit processors, status and durable flush.
Recording is off by default; the launcher omits the sidecar altogether unless asked.

```python
from pathlib import Path

from pdum.codex_launcher import LaunchOptions, launch
from pdum.mitm import SidecarConfig


async def run(profile: Path) -> None:
    options = LaunchOptions(
        mitm_config=SidecarConfig(capture_dir=Path("artifacts/upstream")),
    )
    async with launch(profile, options) as server:
        print(server.endpoint)
        await server.configure_capture(True)
        await server.wait()
```

MITM also works independently through `open_sidecar(...)` and `pdum-mitm`.
Capture files live under a unique run directory: `records.jsonl` and
`manifest.json`. Raw encoded HTTP chunks are retained, including SSE bytes;
semantic JSONL/SSE decoding is not implemented yet. WebSocket captures include
raw bytes plus text/JSON conveniences. No capture-size quotas are imposed.

Forwarding callbacks enqueue observations; processors run separately. Trusted
processors must cooperate with async execution and offload blocking work. This
is not hard CPU/memory isolation or a guarantee of infinite backlog. Status exposes
backlog/failure counters, and unsuccessful writes/flushes are not called durable.

## Composable command trees

```python
import typer

from pdum.codex_launcher.cli import create_app as codex_commands
from pdum.mitm.cli import create_app as mitm_commands

app = typer.Typer()
app.add_typer(codex_commands(), name="codex")
app.add_typer(mitm_commands(), name="mitm")
```

Factories accept explicitly selected registration callbacks; installed entry-point
metadata can be listed without automatically activating providers. Importing or
mounting command trees starts no processes. Optional exporters can implement the
same hooks as the file/test processors; no Logfire/Grafana backend is required.

## Optional management adapter

Install the launcher's `management` extra and call
`pdum.codex_launcher.management.create_app(server)` with an already-owned server.
The returned FastAPI app exposes `GET /status`, `POST /capture` and `POST /stop`;
mount it in an application that owns the launch context and HTTP listener.
Capture accepts `enabled` and an optional `expected_revision`. Creating or mounting
the app does not launch processes, add authentication, or create a second owner.
Stop waits for the existing owner's cleanup. Real local integration tests exercise
these routes with a native app-server and MITM worker, without upstream inference.

## Evidence from 12 October 2026

Validated on macOS arm64, Python 3.12.11/3.13.5/3.14.7, Codex CLI 0.162.1,
mitmproxy 12.2.3 and websockets 16.1.1. Tests use real local endpoints/processes and
the real Codex TUI; see the [testing policy and commands](testing.md). The paid
probe used Python 3.14.7. The Linux CI matrix is configured but has not run yet.

The initial implementation's 61 tests passed on each of these Python versions. That Python 3.14 run
reports 86% line coverage including Python subprocesses. Ruff, pre-commit checks,
the frozen lockfile check, strict MkDocs and both distribution builds also pass.

The fully managed live path was:

```text
vanilla Codex remote TUI → launcher WebSocket relay → native Unix app-server
                                                        ↓
                                               MITM → OpenAI WSS
```

It completed one named-thread Luna turn, observed 20 upstream WebSocket messages,
retained complete admitted captures with zero reported losses, and left the source
auth file unchanged. The final inference reported 13,049 input tokens, 11,008 cached
input tokens and 5 output tokens. A separate warmup response reported 11,806 input
tokens. A conservative API-equivalent upper estimate for the observed short-context
usage was **USD 0.003109375**, not a subscription charge. Rates were checked against
the [official Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna).
The earlier successful manually composed sidecar run estimated USD 0.00310975.
The initial exploratory run was incomplete and used the native TUI's title model;
it is not included as a successful Luna-only validation or a complete billing total.

Complete proxy capture includes ancillary downloads, not just inference: the final
run retained approximately 185 MB across local artifacts. This is why recording is
off by default and storage/backlog monitoring matters even for a tiny prompt.
No raw captures or credentials are committed or uploaded as CI artifacts.

Independent review found and fixed a real native transport issue: native Codex
limits unfragmented frames even when larger fragmented messages are accepted.
The relay now fragments transport sends without truncating captured/application
messages. A real native >16 MiB regression test covers this distinction. Review
also improved cancellation ownership, processor isolation, and flush watermarks.

The profile-setup follow-up adds real PTY Rich/Questionary interviews and paid-free
native plugin/skill discovery and authentication-configuration probes, plus real
local AWS-command/HTTP contract tests. Fixtures in the latter check parsing and
failure behavior, not successful AWS/OpenAI identity federation. No additional
model calls or cloud credential changes were made for the profile-setup iteration.
The expanded suite passes **144 tests on each of Python 3.12.11, 3.13.5 and
3.14.7** on macOS. The cross-version run also corrected test-only inherited-pipe
waiting and interpreter re-exec issues without weakening process-identity checks.

## Not yet qualified or implemented

- Temporary-profile inventory/pruning, exact binary pin enforcement and binary distribution.
- Real cloud identity/renewal checks for the implemented federation helper;
  long-lived credential renewal and fresh interactive ChatGPT login are not
  established by a copied-auth inference check. Existing native config is preserved.
- Windows/network-filesystem ownership, arbitrary wrappers that close inherited
  leases or change their recorded process identity, or guaranteed cleanup of
  detached descendants after an unexpected app-server exit. Uncertain ownership
  refuses reuse rather than deleting a lock. A crash between spawn and completed
  PID journaling can require manual diagnosis rather than automatic cleanup.
- HTTP/2 and IPv6 qualification, semantic HTTP JSONL/SSE decoding, live destination
  switching, archive rotation/pruning and an offline validator.
- Remote logging/metric exporters, pricing service, general thread SDK, daemon,
  profile migration, lockdown mode or adversarial-plugin process isolation.

Built-wheel smoke tests pass: the launcher starts native Codex with neither MITM
nor FastAPI installed; the two wheels together launch an independent MITM worker
and a managed sidecar/app-server. Both installed Typer apps mount under a parent
CLI. Wheels preserve the `pdum` namespace and include typing markers.
No package release or GitHub deployment is part of this implementation session.

## Hostfork

The third distribution, `habemus-papadum-hostfork`, implements the Linux async
library, Typer CLI, copy/overlay/prepared-Btrfs storage, systemd deadlines, direct
Python-owned subprocesses and persistent recovery. See the [guide](hostfork.md)
and [validation record](hostfork-validation.md) for supported behavior and
remaining platform/qualification gates. It is independent of both existing packages.

# habemus-papadum-mitm

Import: `pdum.mitm`. CLI: `pdum-mitm`.

Generic asyncio-managed mitmproxy sidecar with scoped CA/proxy configuration,
HTTP(S)/WebSocket capture, runtime recording controls, complete JSONL payloads,
processor hooks and a mountable Typer CLI. It has no Codex/model knowledge.

```python
from pathlib import Path

from pdum.mitm import SidecarConfig, open_sidecar


async def inspect_network() -> None:
    async with open_sidecar(SidecarConfig(capture_dir=Path("artifacts/captures"))) as proxy:
        environment = proxy.connection.environment({}, trust="openssl")
        print(proxy.connection.proxy_url)
        await proxy.configure_capture(True)
        print(await proxy.status())
```

Supply the returned environment to your consumer and keep it inside the context;
stop the consumer before closing the sidecar. Environment construction never
changes the parent process or installs a global CA. `trust="node"` and
`trust="requests"` select other explicit trust conventions.

Recording starts off. When enabled, files live under a unique run directory with
`records.jsonl` and `manifest.json`. Capture failures are observable and do not
deliberately block forwarding. There are no initial payload/run quotas. Monitor
storage and backlog; captures may contain secrets and must not be committed.

`ProcessorSpec("module:factory", config={...})` selects an importable observer.
`pdum.mitm.cli.create_app()` returns a fresh Typer app for mounting beneath your
own command tree. Installed providers are not automatically activated.

Real local HTTP/TLS/WSS tests validate this first implementation. HTTP/2/IPv6,
semantic SSE decoding, destination switching and archive rotation are not yet
qualified/implemented. See [current capabilities](https://habemus-papadum.github.io/pdum_agent_tools/implementation-status/)
and [testing](https://habemus-papadum.github.io/pdum_agent_tools/testing/) rather than
treating the full [architecture](https://habemus-papadum.github.io/pdum_agent_tools/specs/mitm/) as available behavior.

From the repository root:

```sh
./scripts/setup.sh
uv run --frozen pytest packages/mitm/tests
uv run pdum-mitm --help
uv build --package habemus-papadum-mitm
```

Follow [AGENTS.md](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/AGENTS.md)
and the [development guide](https://habemus-papadum.github.io/pdum_agent_tools/development/).
`pdum` is a shared PEP 420 namespace; do not add `src/pdum/__init__.py`.

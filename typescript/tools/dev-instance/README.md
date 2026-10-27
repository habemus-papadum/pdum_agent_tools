# Isolated orchestrator development instance

`pnpm dev` from `typescript/` starts the root-workspace Python coordinator and
source-linked Vite app, then reports actual ports, identities and unique state/cache
locations. Ctrl-C/SIGTERM closes only this invocation's resources. Its owned child
pipe/handle is the cleanup fallback; no arbitrary PID is looked up by name or port.
The Python child can detect supervisor stdin EOF. State is retained for inspection.

`startDevInstance()` is inert on import and returns actual URLs plus idempotent
`close()`. `/__dev/instance` describes the supervisor; `/api/*` proxies its owner.
Concurrent instances have separate writable state and reject existing state paths.
Source dependencies and tooling can be shared deliberately.

The real integration test requires root `.venv` with workspace packages and
management extras installed. It launches no provider and performs no inference.
See [the guide](../../../docs/orchestrator.md) for current behavior and limits.

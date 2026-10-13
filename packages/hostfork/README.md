# habemus-papadum-hostfork

`pdum.hostfork` creates reusable environments derived from a Linux host, with
private writable trees, ordinary Python-owned subprocesses, aggregate resource
limits, independently enforced deadlines, and retained evidence. It is a tool for
trusted Linux operators, not a security boundary. Unchanged host paths, localhost
services and the host PID namespace remain visible.

The library requires Python 3.12+, Linux user/mount namespaces, cgroup v2 and a
usable user systemd manager with PIDFD scope registration. The tested starting
point is systemd 255. Prepared Btrfs snapshots, stable OverlayFS lowers and ordinary
copies are supported. Hostfork never formats devices during launch.

```python
import asyncio
from pathlib import Path
from pdum.hostfork import EnvironmentSpec, HostView, Hostfork, Lifetime, PrivateTree


async def main():
    source = Path("/srv/experiment")  # existing host directory
    host = Hostfork("/srv/hostfork-state")
    request = EnvironmentSpec(
        trees={"work": PrivateTree(source, storage="copy")},
        view=HostView(replace={str(source): "work"}, fresh=("/dev/shm",)),
        lifetime=Lifetime(max_runtime=1200),
    )
    async with await host.create(request) as environment:
        command = await environment.spawn(["python3", "worker.py"], cwd=source)
        result = await command.wait()
        print(result.returncode, result.stdout_path)
    await environment.export("work", "/srv/results/finished-run")


asyncio.run(main())
```

The command exposes its actual `asyncio.Process` as `native_process`. Pass
`asyncio.subprocess.PIPE` for pipe access; file output is the default and survives
caller failure. Direct-command exit, descendant-group completion, environment
stop and filesystem deletion are separate operations.

```sh
pdum-hostfork --root /srv/hostfork-state doctor --probe
pdum-hostfork --root /srv/hostfork-state run --ttl 1200 \
  --copy /srv/experiment=/srv/experiment --cwd /srv/experiment -- python3 worker.py
pdum-hostfork --root /srv/hostfork-state shell --ttl 1200 \
  --copy /srv/experiment=/srv/experiment --cwd /srv/experiment
pdum-hostfork --root /srv/hostfork-state support plan
pdum-hostfork --root /srv/hostfork-state support install
pdum-hostfork --root /srv/hostfork-state reap
pdum-hostfork --root /srv/hostfork-state usage
```

Both a mountable `app` and `create_app()` are exported from `pdum.hostfork.cli`.
Importing them starts no processes or signal handlers.

Read the [operator/API guide](https://habemus-papadum.github.io/pdum_agent_tools/hostfork/)
for Btrfs preparation, shared services, retention and recovery. Native macOS,
private PID namespaces, allocated PTYs, FastAPI management and GPU allocation are
future backends/adapters. Existing-terminal shell inheritance is supported.

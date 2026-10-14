# Remote filesystem/terminal probe

Run commands from `experiments/`; no extra dependencies or manifests are needed.

- `node spikes/030-codex-remote-operations/probe.mjs`: real credential-free local RPC cases.
- `node spikes/030-codex-remote-operations/large_file.mjs`: exact 5 MiB file read.
- `/Users/nehal/src/pdum_agent_tools/.venv/bin/python spikes/030-codex-remote-operations/browser_harness.py`: HTML and existing production relay; prints URL, endpoint and disposable cwd.
- `node spikes/030-codex-remote-operations/disconnect.mjs ENDPOINT CWD`: connection handle scope and disconnect cleanup; use the harness's disposable cwd.

Set `SPIKE_CODEX_BIN` to an explicit executable for local runners. The browser harness
accepts `--binary`. It accepts `--auth` for the 031 image UI, copying the existing
file login into a disposable home. Terminal checks do not need this option.

The research runners deliberately bound child time/output where relevant to the
case; these limits are not production runtime or observation defaults.
See the [result](../../docs/spikes/030-codex-remote-operations.md).

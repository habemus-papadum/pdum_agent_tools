# Optional Codex research checkout

The imported experiments do **not** contain a Codex Git submodule, source checkout
or compiled executable. This preserves the source identity without copying a
large nested repository into `pdum_agent_tools`.

- Fork: `https://github.com/habemus-papadum/codex.git`
- Upstream: `https://github.com/openai/codex.git`
- Original source pin: `6c372fbef45f730b6d8aa727b0ec8332365588db`
- Original dirty change: the saved
  [Spike 013 patch](../spikes/013-codex-browser-origin/browser-origin.patch).
- Original research revision/context: [import notes](../IMPORT.md).

## Fetch the clean source

Run from `experiments/`, only when a source-dependent experiment needs it:

```sh
git clone --filter=blob:none --no-checkout https://github.com/habemus-papadum/codex.git vendor/codex
git -C vendor/codex checkout --detach 6c372fbef45f730b6d8aa727b0ec8332365588db
git -C vendor/codex rev-parse HEAD
```

If the fork cannot be accessed, fetch the same exact commit from the public
upstream instead; do not substitute its latest branch. Check the printed revision.
This checkout is ignored by the parent repository. Do not remove the ignore rule
or accidentally add nested Git metadata; no `git submodule update` is needed.

The source has its own instructions/toolchain requirements. Read its `AGENTS.md`
before changing it. Native compilation can take significant time/disk and is not
performed by this import. Follow
[Spike 003](../spikes/003-codex-control/README.md) to build its **clean baseline**
before applying the optional browser patch. Old artifact paths do not contain a
prebuilt binary after import.

## Apply Spike 013 deliberately

After a clean baseline exists and only when running the browser-origin experiment:

```sh
git -C vendor/codex apply --check "$PWD/spikes/013-codex-browser-origin/browser-origin.patch"
git -C vendor/codex apply "$PWD/spikes/013-codex-browser-origin/browser-origin.patch"
```

Follow [Spike 013](../spikes/013-codex-browser-origin/README.md) for the separate
app-server build and browser probe. Patch application dirties this local source
checkout; it does not alter the source pin or installed Codex. Do not apply it
twice. To remove only that patch:

```sh
git -C vendor/codex apply --reverse --check "$PWD/spikes/013-codex-browser-origin/browser-origin.patch"
git -C vendor/codex apply --reverse "$PWD/spikes/013-codex-browser-origin/browser-origin.patch"
```

These instructions do not authorize committing, pushing or publishing a custom
Codex build, and the import has not fetched, built or tested this checkout.

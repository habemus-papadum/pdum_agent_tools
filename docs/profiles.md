# Profile setup and authentication

The launcher provides the same setup flow for creating and editing profiles.
The CLI uses **Rich** for TOML previews, warnings and diffs, and **Questionary**
for terminal selections. Library callers use the directory-based draft/edit API
without importing the interview or starting any terminal interaction.

## Daily workflow

```sh
uv run pdum-codex profile create research --model gpt-6-luna
uv run pdum-codex --profile research profile configure
uv run pdum-codex --profile research auth configure
uv run pdum-codex --profile research auth login
uv run pdum-codex --profile research launch
```

The interview runs automatically on an interactive terminal. Use `--interview`
to request it explicitly or `--no-interview` for scripts. `--json` disables
automatic interviews. CLI profile selection is either `--profile NAME`, optionally
with `--profiles-dir ROOT`, or the exclusive `--profile-dir EXACT_DIRECTORY`.
The name argument to `profile create` is a shortcut for the former.

New persistent profiles start from `$CODEX_HOME`, or `~/.codex` when it is unset.
Use `--from-codex-home PATH` or `--from-profile-dir PATH` for another source, or
`--clean` for a fresh profile. A fresh profile has sandboxing and approval prompts
off; importing preserves source native settings rather than silently overriding
them. Listeners remain all-interface by default unless the profile config says
otherwise. `profile configure` always starts from the selected profile itself.
The minimal `create_profile(ProfileSpec(...))` API and `launch --temp` retain their
existing fresh-profile semantics; they do not implicitly import all native settings.

The interview walks through:

1. Marketplaces, plugins, MCP servers and skills: all, none, or individual entries.
   Use arrow keys to navigate and Space to toggle checkbox selections.
2. Model and executable. The resolved executable path is saved, not a bundled binary.
3. Upstream authentication, optional credential snapshot and optional login after saving.
4. Native TOML not represented by those controls: accept it, read it in a pager,
   or edit it using `$VISUAL` / `$EDITOR`.
5. A final diff and save confirmation. Cancellation leaves the profile unchanged.

Unrepresented native TOML and comments are retained. The remainder editor cannot
reintroduce excluded entries or overwrite keys already represented by the interview.
Other native keys remain native; this is not a complete Codex configuration schema.
An explicit model or authentication choice clears the active native `profile`
selector so a named preset cannot silently override it. The `[profiles]` tables
remain available in the remainder, and the change is shown in the diff.

## Experimental native imports

This importer intentionally knows a small part of Codex's evolving native layout.
It is tested against installed **Codex 0.162.1**, informed by source revision
`6c372fbef45f730b6d8aa727b0ec8332365588db`. Unsupported entries or absent assets
produce warnings, not a claim that the resulting integration is operational.

- Marketplace metadata/local checkouts and installed plugin caches are copied.
  Selecting a plugin includes its known marketplace dependency. Selecting a
  marketplace alone does not mean enabling every plugin in its catalog.
- Partial plugin selection disables the native catch-all default, while retaining
  each selected plugin's prior enabled/disabled setting.
- Skills from the source Codex home, a managed profile's isolated user home, and
  the ordinary user's `~/.agents/skills` when importing their default native home
  are discoverable. Selected symlinks are materialized, retaining executable bits.
- Configured MCP definitions, including inline environment values, are copied verbatim.
  External executables, developer-shell environment values, OAuth/keyring state and
  external files are **not** imported automatically.
- Embedded absolute paths inside copied asset contents are not rewritten. Plugin
  data, sessions, system/project config layers and arbitrary home files are not copied.

Warnings identify limitations; a copied MCP definition is not proof of authentication.
Native local `plugin/list` and `skills/list` tests verify selected entries load,
excluded entries stay excluded and the source tree is unchanged.

For scripts, inspect selection IDs first:

```sh
uv run pdum-codex profile inventory --source /path/to/native/home
uv run pdum-codex profile create minimal --no-interview \
  --from-codex-home /path/to/native/home --model gpt-6-luna \
  --marketplace all --plugin none --mcp-server example --skill none
```

Repeat individual selection flags to select several entries; `all` and `none` are
special values when supplied alone. Omitted categories import all their entries.
The interview also accepts these flags as initial selections. Saved profiles are
self-contained where copying is supported; external dependencies remain explicit.

## Authentication is configuration plus an explicit action

Authentication here means **upstream OpenAI/model access**, not WebSocket-client
authentication. Native `codex/config.toml` remains authoritative. The launcher stores
only helper inputs and ownership metadata in `launcher.toml`; it does not implement
a competing credential store or stop clients from sending native login RPCs.

`auth configure` changes settings. `auth login` runs the saved method's explicit
login action. `--login` on create/configure requests that action **after** saving;
`--device-auth` selects native Codex device login for ChatGPT. A failed login does
not roll back the saved settings: retry `auth login`. `auth status` describes the
selected configuration and auth-file presence, not verified authentication validity.

### ChatGPT

```sh
uv run pdum-codex profile create chat --clean --no-interview \
  --auth chatgpt --login --device-auth
uv run pdum-codex --profile chat auth login
```

Native `codex login` runs with the profile's isolated home and a file-backed
credential store. The native process handles token refresh. For a quick start,
use `--copy-auth` during non-clean creation, or select the snapshot in the interview.
The launcher copies `auth.json`, never links it or writes back to its source.
Independent refresh owners can invalidate either session; a profile-specific login
is the cleaner long-lived workflow. Browser/device login still requires the human
to complete OpenAI's interaction.

A custom `[model_providers.openai]` overrides the built-in provider. ChatGPT setup
reports that conflict rather than silently pretending to switch; rename/remove
that custom table first. Selecting another method leaves existing `auth.json`
untouched, but the selected native provider determines whether it is used.

### API key

```sh
uv run pdum-codex --profile research auth configure --no-interview \
  --method api-key --env OPENAI_API_KEY
```

Set the actual key in the parent environment through your ordinary credential
workflow. Only its environment-variable **name** is saved and explicitly inherited
into the otherwise clean child environment. The generated native provider uses the
Responses API and enables WebSockets. `--base-url` on `auth configure`, or
`--auth-base-url` on profile create/configure, selects an alternate endpoint.
There is no interactive API-key login action. Switching methods removes only
launcher-owned inheritance requirements and authentication fields; unrelated
providers/settings are retained.

### AWS workload identity federation

Install the launcher's `federation` extra, or run the workspace's all-extras setup.
Use `auth configure` and select AWS federation, or supply a nonsecret TOML file:

```toml
region = "us-east-1"
identity_provider_id = "idp-example"
service_account_id = "svc_acct-example"
aws_profile = "my-mapped-role"
aws_home = "/absolute/path/to/your/aws-user-home"
login_method = "sso"
```

```sh
uv run pdum-codex --profile research auth configure --no-interview \
  --method aws-federation --federation-settings /path/to/aws-openai.toml
uv run pdum-codex --profile research auth login
```

This requires an **already eligible AWS identity and OpenAI API identity-provider /
service-account mapping**. An arbitrary admin/SSO profile is not necessarily mapped.
The launcher does not create IAM roles, alter trust policies or configure OpenAI
organization mappings. See OpenAI's [AWS federation guide](https://developers.openai.com/api/docs/guides/workload-identity-federation/aws).
This is API-platform workload federation, not a ChatGPT subscription login or the
separate native ChatGPT federation environment-variable flow.

The generated native `model_providers.<name>.auth` command invokes a small Python
helper using this environment's Python executable. On demand, that helper:

1. Runs the AWS CLI's regional STS `get-web-identity-token` operation using the saved
   AWS context, requesting the configured audience and ES384 signature.
2. Exchanges that subject token at OpenAI's token endpoint using the registered
   identity-provider and service-account IDs.
3. Writes only the bearer token to stdout for Codex. It maintains no separate token cache.

Codex caches the helper result for the configured refresh interval (default 240s)
and may call it again on authentication failures. The helper checks that the returned
lifetime exceeds that interval by at least 30s. Background credential acquisition
never starts interactive login. `auth login` separately invokes `aws sso login`
or `aws login`, according to `login_method`. With `login_method = "none"`, it reports
that no interactive login action is configured.

The AWS home/config/credentials/login-cache context applies **only to AWS subprocesses**;
Codex's own home remains isolated. Advanced interview fields expose AWS executable,
explicit config/credentials/cache paths, optional OAuth client ID, audience, timeout
and refresh cadence. Environment-based AWS credentials require explicit launcher
`environment.inherit_keys`; they are not automatically copied from the developer shell.
Keep the Python environment installed at its saved path, or reconfigure the profile
after moving it. Cloning a recognized launcher-owned helper rebases it to the new profile.

**Qualification boundary:** real native Codex accepts the generated configuration
and account routing. Local HTTP/subprocess tests cover the helper exchange contract,
errors, cancellation and expiry validation. Native-to-helper token acquisition,
live AWS/OpenAI federation exchange, fresh browser login and long-running
renewal/reconnection have not been qualified yet. Cloud checks need the
operator's mapped identity. Abrupt native termination of the helper can leave a
custom AWS `credential_process` until it exits or the managed app-server process
group stops. Ordinary cancellation and owned interactive-login orphan cleanup are tested.

## Python API and saving

```python
from pathlib import Path

from pdum.codex_launcher import (
    AuthSpec,
    ImportSelection,
    ProfileEdit,
    load_profile_draft,
    prepare_edit,
    save_profile_edit,
)


async def configure(directory: Path) -> None:
    draft = await load_profile_draft(directory, existing=True)
    edit = ProfileEdit(
        model="gpt-6-luna",
        selection=ImportSelection(mcp_servers="none"),
        auth=AuthSpec("api-key", api_key_env="OPENAI_API_KEY"),
    )
    prepared = prepare_edit(draft, edit)
    await save_profile_edit(prepared)
```

`prepare_edit` is synchronous read/validation/planning; it never writes or logs in.
For a programmatic auth/model-only update, use `import_assets=False` to leave the
installed asset trees untouched. `remaining_config(prepared)` provides the editable
native remainder; put an edited string into `ProfileEdit.remaining_toml` and prepare
again. `save_profile_edit` does not execute `login_after`: that flag is for the CLI;
library callers explicitly await `login_auth(directory)` when desired.

Saving an existing profile requires its exclusive stopped-profile lease, rejects
configuration changed since the interview began, stages copies before replacements,
and rolls back ordinary write failures. Sessions and existing credentials are retained.
Cancellation waits for the off-loop writer before releasing the lease. This is not
a power-loss-atomic multi-file transaction. If rollback itself fails, the error gives
the retained recovery directory rather than discarding originals. Do not run two
tools that independently mutate the same profile tree outside this ownership model.

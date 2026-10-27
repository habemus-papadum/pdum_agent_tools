# Claude setup-token provisioning

**25 October 2026 — bounded compatibility spike, live qualification passed.** Qualify a subscription token
created by the public `claude setup-token` command for isolated workers controlled
by the official Node Agent SDK. The operator's Codex account is not eligible for
workspace access tokens; that separate spike is out of scope.

## Question and plan

Can an operator authorize once on a convenient machine, supply the resulting
token to another isolated profile, and use our existing SDK/launcher transport?
Does changing the token reference affect an already-running worker or only new
workers? Keep profile settings/history separate even when authentication is shared.

The current launcher already has `LaunchOptions.environment` and a management
environment-injection hook. This experiment resolves a selected token file at
**worker allocation** and uses that existing extension point. The production
`AuthSpec` still has only native/API-key/reuse-login choices: no new profile schema,
production auth strategy or general credential service is introduced by the spike.
Our current reuse-login path borrows a normal access token; it does not generate a
setup token and is not a substitute for this qualification.

Applicable contracts and acceptance:

- **RC-07:** status evidence is not model access. A failed or missing result stays
  explicit; no automatic retry or guessed success. Preserve per-conversation cost
  and count submitted inputs even if their result is missing.
- **RC-08:** the official SDK owns its query. Closing its connection ends that
  launcher worker; cleanup verifies stopped processes. No native recovery parsing.
- **RC-09:** identify token provenance and reported usage separately from assumed
  lifetime or actual subscription billing.
- **RC-11:** native auth status can identify an OAuth-token source even when the
  token is deliberately invalid. A live request is separate evidence.

The user selected the Claude spike, completed token provisioning and authorized
bounded live qualification. No further operator input is needed for this spike.
Product choices about
production credential storage, transport between hosts, expiry/rotation UI and
reauthentication while arbitrary tools run remain deferred. Engineering choices
for the isolated harness are delegated.

## Operator step

From the repository root:

```sh
.venv/bin/python experiments/spikes/066-claude-setup-token/provision.py
```

This runs the native authorization flow with a new `CLAUDE_CONFIG_DIR`, then asks
for the printed token at a Questionary prompt that displays asterisks and supports
terminal paste. It stores only that token in
ignored `experiments/artifacts/066-claude-setup-token/setup-token.txt` with mode 0600.
It refuses to replace an existing file unless `--replace` is supplied. To re-copy
an already-generated token without repeating browser login, use
`provision.py --replace --paste-only`. Replacement happens only after valid
nonempty input is entered; cancelling does not replace the previous file.
Do not paste credentials into chat or Git.

On macOS, if the token is already in the clipboard, bypass terminal paste:

```sh
.venv/bin/python experiments/spikes/066-claude-setup-token/provision.py --replace --clipboard
```

This reads the clipboard directly, checks that it looks like a Claude OAuth token,
and stores it without displaying its value. It does not open login or modify the
clipboard. The old `getpass` prompt was replaced after the operator reported that
terminal paste was unreliable; the asterisk prompt uses the existing root
Questionary dependency.
No ordinary profile, Keychain login or credential file is copied or modified.

## Run the experiment

Install the root Python workspace and the independent `experiments/` pnpm
workspace using their existing setup commands. The Python harness calls the
production launcher from the root environment; the Node client uses the pinned
experimental SDK dependency.

From the repository root:

```sh
# Real CLI/SDK initialization and profile isolation; deliberately invalid token,
# zero model requests. This is not proof of authenticated model access.
.venv/bin/python experiments/spikes/066-claude-setup-token/run.py

# After the operator step: real Haiku results plus a rejected replacement token.
.venv/bin/python experiments/spikes/066-claude-setup-token/run.py --live
```

`--token-file PATH` selects another explicitly supplied setup token. The harness
never modifies that source. It uses a private disposable copy for replacement.

The live sequence is bounded to **four submitted inputs**: success in profile A;
an intentionally invalid replacement rejected by a new profile-B worker; another
success in the still-running A worker; and success in a new B worker after restoring
the good reference. Tools are disabled, model is explicitly Haiku, each allocation
has a USD 0.06 native budget, and the whole client has a 330-second deadline. There
is no model substitution or automatic paid retry. Target total spend is under
USD 0.10; a conservative sum of the three inference-bearing worker budgets is
USD 0.18. These experiment bounds do not become runtime defaults.

Each run creates two distinct profiles sharing only a workspace and token source.
Sentinel commands verify settings isolation without inference. The helper records
only selected auth-status fields; emails, account identifiers and token values do
not enter reports. No raw traffic recorder is enabled. All run artifacts remain
ignored. The manager is in-process/foreground and is shut down after the client.

## Evidence and limits

The initial no-model run passed four real checks on Claude Code 2.1.310 / SDK
0.3.296: two independent worker/conversation identities, each profile's own
sentinel command, and process cleanup after SDK disconnect. No credential files
were created and no model inputs submitted. Native status reported logged in with
the deliberately invalid token; this is why the live result is still required.

Read the [result summary](../../docs/spikes/066-claude-setup-token.md) for current
qualification. Reported result cost is conversation-cumulative: take the largest
reported value per new conversation rather than adding every result. A missing
result means its cost is unknown, even if other calls report zero. Neither value
is a measured subscription bill or the implementation agent's cost.

The first supplied token was rejected by both the SDK probe and a separate native
CLI request. Both returned a 401 with zero reported usage. After input repair and
an operator-supplied replacement, the full four-input sequence passed all 11
checks. A worked, a new B with an invalid marker failed authentication, existing
A continued working, and a fresh B worked after reference restoration. All four
workers stopped, source token was untouched, and neither profile acquired native
credential files. The reported total was USD 0.000219, including previous failed
attempts. See the [usage ledger](usage-ledger.md). `direct.py` is a one-input,
USD 0.03-budget Haiku diagnostic that bypasses the SDK/relay. It is a separate,
explicit follow-up, not an automatic retry in the four-input probe.

The documented token lifetime is one year, not a lifetime measured by this spike.
Token replacement is not token revocation. The existing process test checks its
environment snapshot; it cannot establish that a revoked token keeps working.
Separate local profiles do not qualify a network transfer or remote OS. Browser
SDK compatibility shares the worker mechanism but is not automatically established
by the Node-only result.

Official sources, checked 25 October:

- [Generate a long-lived token](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token):
  browser approval, printed token, documented one-year lifetime and subscription
  use. It cannot establish Remote Control or fetch claude.ai connectors; local MCP
  configuration still works. Retain native login for those account features.
- [CLI reference](https://code.claude.com/docs/en/cli-reference): public setup-token
  and auth-status commands. The installed CLI is 2.1.310; pinned Node SDK 0.3.296.

No SDK/library architecture is selected by this experiment. The likely next
implementation is an explicit token reference alongside existing auth strategies,
with token acquisition and assignment separate from profile configuration copying.

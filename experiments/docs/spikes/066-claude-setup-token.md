# 066 — Claude long-lived token provisioning

**25 October 2026 — live qualification passed after replacing the supplied token.**
The user chose this Claude-specific spike. Codex workspace tokens are excluded
because the operator does not have an eligible Business/Enterprise account.

**Result:** a token produced through Claude's public setup-token flow works with
the official Node SDK through our existing Python launcher/relay. Two profiles
can share that credential while keeping their settings separate. Updating the
experiment's credential reference changes new allocations; it does not change
the environment of a running worker. All 11 live checks passed, with a native
SDK-reported cost estimate of **USD 0.000219** across three successful Haiku
responses and one intentional authentication rejection. This is not measured
subscription billing.

The proposed flow is to authorize a long-lived subscription token on a convenient
machine, then supply it to one or more isolated profiles. Claude documents
`setup-token` as a browser authorization command that prints a one-year token;
it does not save that token into the issuing profile automatically. A source
directory selects configuration, not a guaranteed silent credential conversion.
See the [official authentication documentation](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token).

The experiment uses the existing Python launcher's per-worker environment hook
and the official Node SDK. A local token-file reference is resolved at allocation;
only the native worker receives `CLAUDE_CODE_OAUTH_TOKEN`. Two isolated profiles
have separate command/history directories and share an otherwise empty workspace.
No production authentication schema or credential manager has been added.

The [runbook](../../spikes/066-claude-setup-token/README.md) provides an operator-run
provisioning helper and a bounded executable probe. The live checks distinguish
authentication presence from model access, token replacement from revocation, and
existing worker environments from newly allocated workers. They use at most four
short Haiku inputs, including one expected invalid-token failure, and retain
usage/cumulative cost by conversation. RC-07/08/09/11 guide the checks.

The setup token's documented capability is model requests, not the full account
login: it cannot establish Remote Control sessions or fetch claude.ai connectors.
Native profile login remains a separate useful option. Token expiry over a year,
server-side revocation, remote transfer and browser SDK behavior are not yet live
qualified by this spike.

## Successful live sequence

The final run used Claude Code **2.1.310**, official Node SDK **0.3.296**, and the
requested `haiku` alias, reported by the provider as **`claude-haiku-5-5`**. No
model substitution was made.

| Step | Observed result |
| --- | --- |
| Allocate A and B using one token reference | Distinct conversations; each profile exposes only its own sentinel command. B's initialization-only worker closes. |
| Submit to A with the supplied token | Successful exact reply from Haiku. |
| Replace the private reference copy with a deliberately invalid marker; allocate a new B worker | Native authentication rejection, zero reported usage. Native auth status still reports logged in. |
| Submit again to the already-running A worker | Successful exact reply using the previously supplied environment. |
| Restore the private reference; allocate a fresh B worker | Successful exact reply from Haiku. |
| Close SDK clients | All four allocated workers stopped; neither profile acquired a `.credentials.json` file. The operator's source token stayed unchanged. |

The reference is resolved **at allocation in this experiment**, not on every
request. This qualifies that chosen boundary, not hot credential replacement or
automatic refresh inside Claude. Changing a file is not revoking a token: the
old credential remained valid upstream throughout the existing-worker test.

The ignored final evidence is
`20261025T121749Z-live-79090/report.json` under the 066 artifact directory.
The successful responses reported 900 uncached input tokens, 545 cache-creation
tokens, zero cache-read tokens and 40 output tokens. Cost is computed from the
last cumulative report for each new conversation; A's first response is not
charged twice in our summary. There were no missing result records.

## What to carry into the application

Offer a supplied setup-token credential reference alongside native login and API
keys. Acquisition/assignment should be separate from copying profile configuration.
The host can inject the resolved token into the native worker; the browser or
Node conversation client does not need to receive that credential. This experiment
used an existing extension point, so a first-class production auth choice is still
implementation work rather than an already-shipped strategy.

Show credential presence and last successful model validation separately. Track
which credential revision a worker started with when implementing rotation, and
ask about existing-worker policy at that point. Remote credential delivery,
revocation, renewal, browser-client qualification and the documented one-year
lifetime remain distinct follow-ups. None requires private Claude recovery internals.

**Measured without inference:** Claude Code 2.1.310 and official Node SDK
0.3.296 initialized two real launcher workers. Each exposed only its own sentinel
command; conversation IDs differed; SDK disconnect reaped both workers. Neither
profile acquired a `.credentials.json` file. The token in this check was an
explicitly invalid marker, not an operator credential.

That invalid marker nevertheless produced native auth status `loggedIn: true`,
`authMethod: oauth_token`, exit 0. This is direct evidence that status identifies
a selected credential source without establishing working model access. The
no-model run has four passing checks and zero submitted turns. Its ignored
evidence is `20261025T094036Z-no-model-44343/report.json` under this spike's artifact
directory. This result does not qualify setup-token generation or live token use.

## Earlier rejected token and input repair

The operator supplied a token through the isolated provisioning helper. The first
official-SDK input was rejected with `401 OAuth access token is invalid`. The
returned result had `subtype: success` **and `is_error: true`**, a synthetic assistant
error record, zero usage and a reported cost of USD 0. The probe correctly failed
instead of treating the subtype as successful model access. It stopped before
the replacement/restoration sequence and reaped both workers.

One additional bounded request invoked native `claude --print --model haiku`
directly in a fresh profile, with the same supplied token and no SDK or relay.
It returned the same 401, exit 1, zero usage and USD 0 reported cost. This isolates
the observed failure from the SDK/relay path; it does not explain whether the
credential was copied incompletely, revoked or otherwise rejected upstream.
The token had the expected OAuth prefix and no whitespace/assignment wrapper;
its value was not printed. Both checks left the source token unchanged.

Private reports: `20261025T115609Z-live-70546/report.json` and
`20261025T115842Z-direct-71111/report.json` under the ignored 066 artifact directory.
The operator was asked to re-copy the complete token or generate a fresh one.
The helper now supports explicit replacement without touching normal login state.

The operator then reported that pasting into the `getpass` prompt was unreliable.
The helper now uses Questionary's asterisk-masked password prompt; an actual PTY
check accepted bracketed paste, rendered asterisks and did not echo the input.
A macOS `--clipboard` option bypasses the prompt. The agent's attempted clipboard
import did not find a matching OAuth token and left the stored file unchanged.
The operator supplied a replacement from their own terminal, after which the full
sequence above passed. The original rejection's precise cause was not established.
No model requests were made during the input fix itself.

**Total reported inference cost: USD 0.000219**, including the earlier zero-cost
rejections. See the [usage ledger](../../spikes/066-claude-setup-token/usage-ledger.md).
No ordinary profile or source credential was modified, and no experiment process
remains running. The supplied token remains in its ignored local file for the
operator; transient worker-token copies were removed.

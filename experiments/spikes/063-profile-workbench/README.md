# Profile workbench

**Working disposable study, 24 October 2026.** Open `/profiles/` in the shared 055
lab. This is a small usable editor over real native configuration, with local lab
writes. It remains disposable code rather than a production profile SDK.

## Try the journey

- Select an ordinary profile to inspect its native TOML or JSON, or choose
  **New profile**. Authentication evidence is explicitly configuration/presence,
  not a successful sign-in or model-access result.
- **Make lab copy** starts from the selected profile's native settings. Name it,
  inspect the destination, and create it. The backend calls the existing launcher.
- Edit the created profile's native text and **Save native config**. Unknown fields
  and comments survive unless you explicitly edit them. Syntax errors and stale
  file revisions are shown; a failed save does not replace the file.
- Expand **One-run override preview**. The separate model choice changes the
  suggested Codex launch argument or Claude worker-allocation payload only; no launch occurs and the file stays unchanged.
- The authentication link opens the independent reviewed study. It does not
  authenticate the real profile or pretend to pass it into that simulation.

The two `review-codex` and `review-claude` entries were created through this page
for review. They are real unlaunched profiles, not fictional status fixtures.
The small `review_extension` table in the former demonstrates retaining an
unrecognized native TOML table.

## Existing owners and exact effects

| UI operation | Existing implementation | Important distinction |
| --- | --- | --- |
| Read existing profile | Codex `inspect_profile`; Claude `load_profile`; native text read | Source profile remains read-only in this study. Deliberate raw inspection may show sensitive values already in native config. |
| Create Codex | `create_profile(ProfileSpec(source=…, model=…, copy_auth=False, copy_skills=False))` | A profile is a Codex home. The library preserves native config and launcher metadata from a base; no sessions or auth.json are copied. |
| Create Claude | `create_profile(workspace=…, model=…, native_settings=…, …)` | Copies native settings only. New auth strategy references `ANTHROPIC_API_KEY`; it does not resolve/read that variable. |
| Save native editor | Parse with native TOML/JSON syntax, then existing atomic-write primitive | Full text is the user's edit. No second provider configuration schema; unrelated unknown values are preserved. |
| One-run model | Codex launch `--model`; Claude existing manager `POST /api/workers` with `options.model` | Claude named-profile `launch --model` does not override the saved profile; the page previews worker allocation separately. Neither preview is executed. |

All writes target `experiments/artifacts/063-profile-workbench/profiles/<provider>/`.
`PDUM_PROFILE_LAB_DIR` can select an isolated alternate lab root for checks.
This is a study directory, not a new launcher/profile convention. The source
profile is never edited by copying. Existing destinations are errors. Native
configuration and copied launcher metadata can contain credential environment
references, inline values and external paths; excluding auth files is not a
promise to scrub arbitrary configuration. Raw configuration stays local and is
not printed in the report or committed.

Codex model/default settings live in native `config.toml`. Claude's launch model,
workspace and settings scopes live in the **existing launcher `profile.json`**;
this first UI chooses them at creation, while later editing exposes native
`claude/settings.json`. Existing Claude launcher metadata editing is not yet a
separate screen. Base creation is a snapshot, not an inheritance mechanism.
Credential files, histories, skills and agents are not copied by this study.
External/project settings referenced by a configuration remain external/project
settings, including Claude's selected project scope.

## Interaction and engineering limits

The compact sidebar, file editor and optional details use Solid/AIUI controls,
action tools and cells. Space opens the same shared command map. An unsaved editor
cannot silently switch to another profile or new-profile form; save or discard
and reload first. Saving checks the loaded revision against the current file,
which catches a competing edit. This is basic file hygiene, not a general lock
or multi-client editing protocol.

**RC-01/07/08** apply. A configuration change is not evidence of a running worker
adopting it. No active worker is restarted or credential refreshed here. Before
live authentication or launch, resolve the policy questions in 060's handoff;
before shutdown/control, follow the runtime lifetime contracts. The temporary
HTTP adapter under 062 is local lab plumbing, not a proposed production protocol.

Still open: remote edits, native import/skills choices, full configuration diffs,
existing Claude launcher-metadata editing, credential setup and actual launch.
Those are meaningful next interactions; none is represented as synthetic success.
This pass does not require a new shared editor package or a complete test strategy.

## Checks and cost

`062/bridge.test.mjs` exercised both actual launcher libraries: create, edit,
copy, native unknown-field/comment retention, no auth-file copying, source unchanged,
existing-target rejection, stale revision rejection and refusal to write outside
the selected lab root. Browser actions created both review profiles and saved the
Codex extension table; the editor returned to clean state after save. The final
pages were checked at 1440×900 and 390×844, with no page horizontal overflow or
browser warnings/errors. Component edits preserved the open document; changing
store declarations reloads the page by design.

Typecheck/build are run through the shared 055 package. No provider inference,
credential-store access, login, worker launch or production package change occurred.
Provider inference cost: **USD 0**, excluding implementation-assistant effort.

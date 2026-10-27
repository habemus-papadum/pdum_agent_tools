# 063 — Real native profile workbench

**24 October 2026; working disposable application, ready for interaction review.**
The `/profiles/` page inspects real Codex/Claude profiles and creates editable copies
through the existing launcher libraries. The compact sidebar and native editor
follow the reviewed dense presentation; backend details sit in optional inspection
and these notes.

The working journey is **choose a profile → inspect native settings → create a
lab copy or a fresh profile → edit and save**. Ordinary profiles remain read-only
in this study. The page created real `review-codex` and `review-claude` profiles,
then saved an unrecognized native TOML extension in the former. They remain
available for review, unlaunched and without copied credential files.

The configuration owners have not changed. Codex profiles are native Codex homes.
Claude profiles retain their existing launcher metadata plus native settings JSON.
The editor writes the native file, checks its syntax and loaded revision, and
preserves unknown fields/comments outside explicit edits. A separate one-run model
override preview leaves profile defaults unchanged. No new inheritance or provider
configuration schema was introduced.

The useful limitation is that **saving settings is not evidence that an existing
worker adopts them**. Authentication and live reconfiguration remain separate
work, as recorded in 060 and RC-01/07/08. Claude's launch model/workspace are chosen
at creation; editing existing launcher metadata is a later UI slice. Remote edits,
login and actual launch are also absent, rather than demonstrated with fictional
success receipts.

Two focused shared integration tests cover actual launcher creation/copy/edit,
source preservation, unknown fields, no auth-file copy, write boundaries and
competing revisions. Real browser creation/save journeys passed; desktop and
390-pixel phone layouts had no horizontal page overflow or final browser warnings.
No production SDK/component extraction was attempted.

Open the [page](http://localhost:56044/profiles/) and read the
[runbook / native operation map](../../spikes/063-profile-workbench/README.md).
New files live under ignored `experiments/artifacts/063-profile-workbench/`.
This UI is disposable; its HTTP transport is not a proposed public API.

**New provider inference spend: USD 0.** No login or worker launch occurred; no
ordinary profile, session or credential store was changed.

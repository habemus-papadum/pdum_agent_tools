# 059 — Captured rich-message examples

**24 October 2026.** The viewer now has a **Rich messages · prompts and responses**
collection with six direct jump points. These are independent native captures,
not a newly invented parent/child family or a synthetic conversation. Selecting
an example locates its native message identity, expands it and brings it into view.
The surrounding original conversation remains available.

Open the [collection on the local preview](http://localhost:56044/history/?group=rich-messages).
The same entry is under **Families & examples** in the viewer. Links below use the
usual local preview port; change the origin if running a different instance.

| Example | What is actually present | Jump |
| --- | --- | --- |
| Claude image prompt | Human text plus an embedded uploaded image, in the actual user message | [Open prompt](http://localhost:56044/history/?group=rich-messages&example=user-image-claude) |
| Codex image prompt | Human text plus a native local-image reference; exported bytes available | [Open prompt](http://localhost:56044/history/?group=rich-messages&example=user-image-codex-a) |
| Another Codex screenshot prompt | A second human image prompt in the same native conversation | [Open prompt](http://localhost:56044/history/?group=rich-messages&example=user-image-codex-b) |
| Mathematical final response | Genuine assistant prose with equations and native `final_answer` phase | [Open state-model response](http://localhost:56044/history/?group=rich-messages&example=math-final-state-model) |
| Another mathematical final response | Further equations in a native final response | [Open covariance response](http://localhost:56044/history/?group=rich-messages&example=math-final-covariance) |
| Mathematical progress update | A formula inside a native `commentary` message | [Open update](http://localhost:56044/history/?group=rich-messages&example=math-update-validation) |

The image prompts are **not tool results**. Thumbnail hover, detail and pinning use
the existing Lens interaction. Claude's image bytes are embedded in history. The
Codex reference copies retain the explicit qualification that they were copied
at export time and have not been verified as byte-identical to the historical image.

## What was not found

The selected image prompts contain human text and pictures, but no qualified TeX.
No unambiguous human-authored TeX prompt, image-plus-TeX in one human prompt, or
assistant-authored image in an update/final response was found in the inspected
histories. This is a corpus gap, not a claim that a provider or renderer cannot
support those cases. Image pixels were not classified as mathematical content.

The audit covered 89 distinct exported native documents and a read-only search
of ordinary Codex rollouts and top-level Claude transcripts. Eight broader
math-bearing user-role candidates were rejected because they were teammate
messages, task notifications or compaction summaries. Source search results were
not substituted for native API evidence. Likewise, tool-returned screenshots
were not relabelled as assistant-authored pictures.

The three missing cases are listed in the collection's **Examples still missing**
panel. The separate synthetic rendering bench remains available, with its original
label; it does not fill these native-evidence gaps.

## Data and implementation

`collect_rich_examples.py` copies three existing native API documents byte-for-byte
(approximately 11.93 MB), plus seven already-exported assets with verified hashes.
The private manifest holds native identities, roles, phases, feature qualification
and review labels. Existing individual captures and family runs remain unchanged.

The temporary transport marks the group as a **collection** and preserves its mixed
Codex/Claude documents. Its initial document key is a navigation choice, not a
parent relation. Reader/model checks reject a bookmark whose native message,
provider, role or phase does not agree with its capture. The viewer resolves the
native identity; it does not fall back to a guessed ordinal. Display labels remain
outside the native payload.

Initial URL/example selection is derived from the loaded capture and yields to an
explicit reader selection. It does not use an effect that rewrites its own inputs.
Direct links and sidebar buttons use the same qualified points. No provider was
contacted, no session resumed, and no history or credentials were changed.

Reproduce from the repository root using the existing private selection file and
a new output directory:

```sh
uv run --frozen python experiments/spikes/058-native-history-access/collect_rich_examples.py \
  --selection experiments/artifacts/058-native-history-access/rich-messages/selection.json \
  --output experiments/artifacts/058-native-history-access/rich-messages-new
```

The current private `collection.json`, `evidence.json`, document copies and assets
live under ignored `experiments/artifacts/058-native-history-access/rich-messages/`.
No raw captures or private identifiers belong in committed examples. The local
preview reads this collection via the existing GET-only family/collection transport.

See the [availability ledger](059-data-availability.md) for implications for future
types: message role alone does not establish authorship, capture-group membership
is not ancestry, and missing examples are different from unsupported data shapes.
New experiment inference: **USD 0**.

Validation: **63 browser checks passed at 1440×900 and 390×844**, including all
six actual messages, native role/phase matching, image decoding, TeX rendering,
automatic URL/selector positioning, missing-case disclosures, unchanged payloads
and no horizontal overflow. Each of the six fresh deep links additionally passed
five focused checks. Shared **40 model/cell checks**, **12 reader/HTTP checks**,
typecheck/build and strict documentation checks passed. The collector's Ruff
checks and copy/hash validation passed. Fresh consoles had only bounded
`HOT_SCOPE_TIME` observations (10.3–18.8 ms), without errors or loading-feedback
warnings. No warnings were suppressed.

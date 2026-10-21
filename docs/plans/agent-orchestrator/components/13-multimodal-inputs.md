# O13 — Voice, screen and pencil inputs

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Provide independent input surfaces that contribute deliberate material to the prompt composer. Voice, screen capture and ink should also be useful to other AIUI applications.

## Existing foundation

Public upstream packages include aiui-audio, aiui-stt, aiui-screen-capture and aiui-pencil. The inspected STT path uses ElevenLabs Scribe; the upstream internal oracle/live/dock packages are reference scaffolding, not consumer dependencies.

## Proposed boundary

Acquisition, editing, capture snapshots and model submission are separate lifetimes. Preserve input arriving after a capture rather than discarding it with the submitted snapshot. Browser/OS capture gestures remain part of the flow. A Node host can consume resulting assets without owning browser capture.

**Inputs and outputs:** Microphone segments, selected screen frames/regions and editable strokes → draft text/assets with capture identity and provenance.

## Candidate progression

- **Mock:** Three independently usable panels: dictate/revise text; select/preview a capture; draw/erase/review ink and combine it with an image.
- **First usable slice:** Choose one modality after review and qualify its capture-to-draft-to-submit path, including cancel and late completion.
- **Later:** Coordinated multimodal gestures, overlays, reusable capture sessions and richer interpretation, with host-injected credentials.

These are discussion candidates, not scheduled work or implemented capabilities.

## Your additions

- How should voice, capture and pencil be activated and combined in the normal workflow?
- Which captured material should remain editable, and what should be retired after a successful submission?

Additional requirements, examples and decisions: **TBD with you.**

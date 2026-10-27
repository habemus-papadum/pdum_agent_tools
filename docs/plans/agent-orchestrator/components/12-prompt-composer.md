# O12 — Prompt composer and inspection

**Status: design stub.** [Back to the component map](../index.md).

## Purpose

Build rich prompts from text, selected context, captures and reusable material, then inspect what the selected agent will receive. Keep editing separate from submission.

## Existing foundation

The actual aiui-prompts and prompts-inspector source is already used by [HP experiments](../../../hp-agent-findings.md). A sophisticated reusable orchestrator composer is proposed.

## Proposed boundary

Preserve editable draft inputs, submitted snapshots and provider wire representation as distinct records. Provider adapters declare supported media and delivery forms. Capture/input preparation finishing late must not alter an already-submitted prompt.

**Inputs and outputs:** Draft fragments, assets, context references and target capabilities → a frozen submission plus an inspectable prompt record.

## Candidate progression

- **First usable slice:** A simple text-only placeholder producing a shared prompt record and structured rendered content; provider adapters format that content into native input messages.
- **Independent disposable experiments:** Rich editing, images, voice, capture, pencil and prompt inspection, without gating the main workflow.
- **Later integration:** Replace the placeholder through the same content boundary after review; retain templates, source/provenance and provider capability distinctions.

These are discussion candidates, not scheduled work or implemented capabilities.

## Recorded review — 19 October 2026

Add the concrete [O17 workflow](17-files-commands.md#your-additions): selected
source code and comments from a read-only file viewer become draft prompt
material. Preserve file/host/path and available content-version provenance.
Prompt submission follows explicit target/timing choices in O09; composing a
draft does not silently choose steer versus queue versus new work.

## Recorded review — 26 October 2026

Keep the initial UI very simple. Its output is the shared structured/rendered
prompt, potentially containing ordered images and other parts in the future.
Destination-specific adapters produce the proper client messages; the editor
does not choose native turn/steer/queue behavior. Rich-content types do not imply
that each provider already accepts those parts. The richer prompting design will
be decided through separate, self-contained disposable experiments. See
[D10 and the content boundary](../system/decisions.md#simple-composer-durable-content-boundary).

## Your additions

- What should the everyday composer look like, and when should its assembly/inspection details appear?
- How should drafts, reusable prompts and per-agent context selections be saved or shared?

Additional requirements, examples and decisions: **TBD with you.**

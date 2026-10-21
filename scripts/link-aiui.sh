#!/usr/bin/env bash
# Local source access only: no package installation or writes to the AIUI checkout.
set -euo pipefail

if [[ $# -gt 1 || "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: $0 [AIUI_REPO]"
  echo "Links .dev/aiui to the sibling pdum_aiui checkout, or the supplied path."
  [[ $# -le 1 ]]
  exit
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
aiui_source=${1:-"$repo_root/../pdum_aiui"}
if [[ ! -d "$aiui_source" ]]; then
  echo "AIUI checkout not found: $aiui_source" >&2
  exit 1
fi
aiui_source=$(CDPATH= cd -- "$aiui_source" && pwd -P)
for required in AGENTS.md packages/aiui-viz/package.json packages/aiui-prompts/package.json skills/aiui-architecture/SKILL.md; do
  if [[ ! -f "$aiui_source/$required" ]]; then
    echo "Not an AIUI checkout: missing $aiui_source/$required" >&2
    exit 1
  fi
done

if [[ -L "$repo_root/.dev" ]]; then
  echo "Refusing to write through an existing .dev symlink." >&2
  exit 1
fi
mkdir -p "$repo_root/.dev"
aiui_link="$repo_root/.dev/aiui"
if [[ -L "$aiui_link" ]]; then
  if [[ "$(readlink "$aiui_link")" != "$aiui_source" ]]; then
    echo "Existing $aiui_link points elsewhere; update that link explicitly." >&2
    exit 1
  fi
elif [[ -e "$aiui_link" ]]; then
  echo "Refusing to replace existing file/directory: $aiui_link" >&2
  exit 1
else
  ln -s "$aiui_source" "$aiui_link"
fi
printf 'AIUI source link: %s -> %s\n' "$aiui_link" "$aiui_source"
echo "This exposes local source; consuming apps still need explicit package dependencies."

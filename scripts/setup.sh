#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
uv sync --frozen --all-packages
uv run --frozen pre-commit install

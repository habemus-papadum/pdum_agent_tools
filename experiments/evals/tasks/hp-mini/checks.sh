#!/bin/sh
# Independent checks are outside the agent's scratch project.
set -u
task_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node "$task_dir/check.mjs" "$1"

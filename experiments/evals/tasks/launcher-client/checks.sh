#!/bin/zsh
# Objective gates for the launcher-client task: checks.sh <worktree>
# Prints one `CHECK <name> <ok|FAIL> [detail]` line per gate, then the verbose output report.py archives.
set -u
wt="$1"
cd "$wt" || { echo "CHECK worktree FAIL missing $wt"; exit 1; }
pkg=typescript/packages/claude-launcher-client

if [[ -d $pkg ]]; then echo "CHECK package-present ok"; else echo "CHECK package-present FAIL $pkg missing"; fi
if git status --short -- packages/ pyproject.toml uv.lock | grep -q .; then echo "CHECK python-untouched FAIL"; else echo "CHECK python-untouched ok"; fi
outside=$(git status --short | grep -v "$pkg" | wc -l | tr -d ' ')
echo "CHECK files-outside-package ok $outside"

cd typescript || { echo "CHECK install FAIL no typescript dir"; exit 1; }
if pnpm install --frozen-lockfile >/tmp/eval-install.log 2>&1; then echo "CHECK install ok"; else echo "CHECK install FAIL see log"; tail -5 /tmp/eval-install.log; fi
if pnpm lint >/tmp/eval-lint.log 2>&1; then echo "CHECK lint ok"; else echo "CHECK lint FAIL"; tail -8 /tmp/eval-lint.log; fi
if pnpm -r typecheck >/tmp/eval-typecheck.log 2>&1; then echo "CHECK typecheck ok"; else echo "CHECK typecheck FAIL"; tail -12 /tmp/eval-typecheck.log; fi
if pnpm -C packages/claude-launcher-client test >/tmp/eval-test.log 2>&1; then
  count=$(grep -oE 'Tests +[0-9]+ passed' /tmp/eval-test.log | grep -oE '[0-9]+' | head -1)
  echo "CHECK test ok ${count:-0} passed"
else
  echo "CHECK test FAIL"; grep -E 'FAIL|×|Error' /tmp/eval-test.log | head -8
fi
if pnpm test >/tmp/eval-test-all.log 2>&1; then echo "CHECK test-workspace ok"; else echo "CHECK test-workspace FAIL"; fi
if pnpm -C packages/claude-launcher-client build >/tmp/eval-build.log 2>&1; then echo "CHECK build ok"; else echo "CHECK build FAIL"; tail -5 /tmp/eval-build.log; fi

echo "---- files ----"
cd "$wt"
find $pkg -type f -not -path '*/node_modules/*' -not -path '*/dist/*' | sort | while read -r f; do printf "%6d %s\n" "$(wc -l < "$f")" "$f"; done
echo "---- status ----"
git status --short
echo "---- exports ----"
grep -rhoE '^export (async )?(function|class|type|interface|const) [A-Za-z0-9_]+' $pkg/src 2>/dev/null | sort -u

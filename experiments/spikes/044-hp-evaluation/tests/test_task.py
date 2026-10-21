"""Check that the independent task gates reject the seed and accept a reference repair."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

TASK = Path(__file__).resolve().parents[3] / "evals" / "tasks" / "hp-mini"


def test_seed_exposes_real_regressions():
    result = subprocess.run(["node", str(TASK / "check.mjs"), str(TASK / "fixture")], capture_output=True, text=True)
    assert result.returncode == 1
    for gate in [
        "cache-subset",
        "revisions-and-ties",
        "inherited-before-dedup",
        "session-scoped-identity",
        "frozen-input",
    ]:
        assert f"CHECK {gate} FAIL" in result.stdout


def test_reference_repair_passes_independent_checks(tmp_path):
    scratch = tmp_path / "scratch"
    shutil.copytree(TASK / "fixture", scratch)
    (scratch / "src" / "usage.mjs").write_text("""
export function summarizeUsage(records) {
  const latest = new Map();
  for (const record of records) {
    if (record.origin === 'copied-context') continue;
    const key = JSON.stringify([record.sessionId, record.requestId]);
    const old = latest.get(key);
    if (!old || old.revision <= record.revision) latest.set(key, record);
  }
  const zero = () => ({requests:0,inputTokens:0,cachedInputTokens:0,uncachedInputTokens:0,outputTokens:0});
  const sessions = new Map(); const totals = zero();
  for (const record of latest.values()) {
    const row = sessions.get(record.sessionId) ?? {sessionId:record.sessionId,...zero()};
    const delta = {requests:1,inputTokens:record.inputTokens,cachedInputTokens:record.cachedInputTokens,
      uncachedInputTokens:record.inputTokens-record.cachedInputTokens,outputTokens:record.outputTokens};
    for (const key of Object.keys(delta)) { row[key] += delta[key]; totals[key] += delta[key]; }
    sessions.set(record.sessionId,row);
  }
  return {sessions:[...sessions.values()].sort((a,b)=>a.sessionId<b.sessionId?-1:a.sessionId>b.sessionId?1:0),totals};
}
""")
    (scratch / "README.md").write_text("Cached tokens are a subset of input.\n")
    (scratch / "test" / "usage.test.mjs").write_text("""
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarizeUsage} from '../src/usage.mjs';
for (const [key, value] of Object.entries({requests:0,inputTokens:0,cachedInputTokens:0,outputTokens:0})) {
  test(key,()=>assert.equal(summarizeUsage([]).totals[key],value));
}
""")
    result = subprocess.run(["node", str(TASK / "check.mjs"), str(scratch)], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "CHECK test ok 4 passed" in result.stdout


def test_preparation_preserves_exact_task_and_creates_no_git_state(tmp_path, monkeypatch):
    monkeypatch.setenv("EVALS_HOME", str(tmp_path))
    prepare = Path(__file__).resolve().parents[1] / "prepare.py"
    result = subprocess.run(
        ["python", str(prepare), "--run-id", "arm", "--agent", "hp"], capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    manifest = json.loads((tmp_path / "arm" / "run.json").read_text())
    assert manifest["config"]["model"] == "gpt-6-luna"
    assert manifest["config"]["reasoning_effort"] == "low"
    assert (tmp_path / "arm" / "prompt.txt").read_bytes() == (TASK / "prompt.txt").read_bytes()
    assert not (tmp_path / "arm" / "worktree" / ".git").exists()

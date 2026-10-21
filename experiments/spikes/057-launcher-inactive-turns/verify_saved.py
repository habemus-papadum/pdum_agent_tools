"""Inspect preserved live evidence without paying to rerun its model turns."""

import json
import sys
import tomllib
from pathlib import Path

path = Path(sys.argv[1]).resolve()
result = json.loads((path / "result.json").read_text())
expected = [
    "Automatic unload actually kills the managed heartbeat OS process",
    "Relay preserves exact native thread-not-found error",
    "App-server process is still the same process",
    "Explicit resume reconstructs the same conversation ID",
    "Resuming history does not resurrect the terminal",
    "New turn succeeds after explicit resume through the same relay",
]
assert all(check in result["checks"] for check in expected)
assert result["error"] == "AssertionError: Launch overrides did not edit native profile config"
assert result["sourceAuthUnchanged"] is True
config = tomllib.loads((path / "profile/config.toml").read_text())
assert "thread_unload_delay_secs" not in config
assert result["effectiveDelay"] == 3
verification = {
    "runtimeChecksAlreadyPassed": len(result["checks"]),
    "nativeDelayOverrideStillAbsentOnDisk": True,
    "originalRunErrorRetained": result["error"],
    "explanation": "Whole-file hash check was overbroad; native thread/start persisted project trust.",
    "additionalProviderTurns": 0,
}
(path / "post-run-verification.json").write_text(json.dumps(verification, indent=2) + "\n")
print(json.dumps(verification))

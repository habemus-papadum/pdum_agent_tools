import sys
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "002-claude-traffic/python"))
import capture as shared_capture

shared_capture.SECRET_KEYS.update({"chatgpt-account-id", "chatgptaccountid", "account_id", "email", "accesstoken"})
base_redact = shared_capture.redact


def redact(value):
    value = base_redact(value)
    if isinstance(value, str) and (account := os.environ.get("SPIKE_REDACT_ACCOUNT_ID")):
        return value.replace(account, "[REDACTED]")
    return value


shared_capture.redact = redact
addons = shared_capture.addons

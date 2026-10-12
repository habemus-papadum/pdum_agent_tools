import json

from pdum.codex_launcher.metrics import UsageObserver
from pdum.codex_launcher.observation import Observation


async def test_usage_snapshots_do_not_sum_repeated_totals():
    processor = UsageObserver()
    await processor.open()
    usage = {"total": {"inputTokens": 120, "cachedInputTokens": 100}, "last": {"inputTokens": 30}}
    message = {
        "method": "thread/tokenUsage/updated",
        "params": {"threadId": "thread", "turnId": "turn", "tokenUsage": usage},
    }
    for sequence in range(1, 4):
        await processor.process(Observation("run", "conn", sequence, "server_to_client", json.dumps(message)))
    snapshot = processor.snapshot()["thread"]
    assert snapshot["token_usage"] == usage
    assert snapshot["source_seq"] == 3
    assert "modelContextWindow" not in snapshot["token_usage"]
    snapshot["token_usage"]["total"]["inputTokens"] = 0
    assert processor.snapshot()["thread"]["token_usage"]["total"]["inputTokens"] == 120
    await processor.close()


async def test_unknown_and_malformed_observations_leave_usage_unknown():
    processor = UsageObserver()
    for payload in ("invalid", "[]", '{"method":"future/event"}', b"\xff"):
        await processor.process(Observation("run", "conn", 1, "server_to_client", payload))
    assert processor.snapshot() == {}

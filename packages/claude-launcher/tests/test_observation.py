"""Capture failures and cumulative native usage never control the relay."""

import asyncio
import base64
import json

from pdum.claude_launcher import JsonlRecorder, ObservationHub, UsageObserver


async def test_full_bytes_and_cumulative_results(tmp_path):
    recorder = JsonlRecorder(tmp_path / "capture.jsonl")
    usage = UsageObserver()
    hub = ObservationHub((recorder, usage))
    await hub.start()
    frame = json.dumps({"type": "result", "session_id": "conversation", "total_cost_usd": 0.01}).encode() + b"\n"
    payload = b"x" * 2_000_000
    hub.emit("worker", "client_to_worker", payload)
    hub.emit("worker", "worker_to_client", frame[:13])
    hub.emit("worker", "worker_to_client", frame[13:])
    hub.emit("resumed", "worker_to_client", frame)
    await hub.close()
    rows = [json.loads(line) for line in recorder.path.read_text().splitlines()]
    assert base64.b64decode(rows[0]["payload"]) == payload
    assert usage.status()["conversation_totals_usd"] == {"conversation": 0.01}
    assert usage.status()["missing_result_cost"] == "unknown"
    assert recorder.bytes_written == recorder.path.stat().st_size
    assert recorder.storage_free_bytes > 0
    assert all(state["lost"] == state["pending_bytes"] == 0 for state in hub.status())


async def test_failed_recorder_counts_loss_without_stopping_healthy_processor(tmp_path):
    destination = tmp_path / "existing"
    destination.write_text("preserve this")
    usage = UsageObserver()
    hub = ObservationHub((JsonlRecorder(destination), usage))
    await hub.start()
    hub.emit("one", "client_to_worker", b"first")
    for _ in range(100):
        if hub.status()[0]["error"]:
            break
        await asyncio.sleep(0.01)
    assert hub.status()[0]["error"] == "FileExistsError"
    hub.emit("two", "worker_to_client", b'{"type":"result","session_id":"x","total_cost_usd":0.1}\n')
    await hub.close()
    status = hub.status()
    assert status[0]["lost"] == 2
    assert status[0]["pending_records"] == 0
    assert status[1]["processed"] == 2
    assert status[1]["lost"] == 0
    assert destination.read_text() == "preserve this"
    assert usage.conversation_totals == {"x": 0.1}


async def test_blocked_processor_does_not_block_emit_and_drain_reports_loss():
    entered = asyncio.Event()

    class Blocked:
        async def open(self):
            pass

        async def process(self, observation):
            entered.set()
            await asyncio.Event().wait()

        async def close(self):
            pass

    hub = ObservationHub((Blocked(),), close_timeout=0.02)
    await hub.start()
    hub.emit("a", "client_to_worker", b"one")
    await entered.wait()
    hub.emit("b", "client_to_worker", b"two")
    assert hub.status()[0]["pending_bytes"] == 6
    async with asyncio.timeout(1):
        await hub.close()
    state = hub.status()[0]
    assert state["error"] == "Drain timeout"
    assert state["lost"] == 2
    assert state["pending_records"] == state["pending_bytes"] == 0

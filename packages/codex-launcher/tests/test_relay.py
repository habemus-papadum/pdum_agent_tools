import asyncio
import base64
import json
from tempfile import TemporaryDirectory

import pytest
from pdum.codex_launcher.observation import JsonlRecorder, Observation, Observer
from pdum.codex_launcher.relay import open_relay
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve, unix_serve


async def echo(connection):
    async for message in connection:
        await connection.send(message)


async def test_relay_browser_origin_binary_large_messages_and_capture(tmp_path):
    seen_headers = []

    async def backend(connection):
        seen_headers.append(dict(connection.request.headers))
        await echo(connection)

    capture_path = tmp_path / "messages.jsonl"
    async with serve(backend, "127.0.0.1", 0, origins=[None], max_size=None) as upstream:
        endpoint = f"ws://127.0.0.1:{upstream.sockets[0].getsockname()[1]}"
        async with open_relay(endpoint, processors=[JsonlRecorder(capture_path)]) as relay:
            assert relay.bind_endpoint.startswith("ws://0.0.0.0:")
            async with connect(
                relay.endpoint, origin="http://different-host:1234", proxy=None, max_size=None
            ) as client:
                messages = ['{"id":1,"method":"unknown"}', b"\x00\xff\x01", "large:" + "x" * (17 * 1024 * 1024)]
                for message in messages:
                    await client.send(message)
                    assert await asyncio.wait_for(client.recv(), 10) == message
            assert (await relay.status())["total_connections"] == 1
    records = [json.loads(line) for line in capture_path.read_text().splitlines()]
    assert len(records) == 6
    assert "origin" not in seen_headers[0]
    assert [record["seq"] for record in records] == list(range(1, 7))
    assert base64.b64decode(records[2]["payload"]) == messages[1]
    assert records[-1]["payload"] == messages[-1]


async def test_unix_backend_separate_client_sessions():
    with TemporaryDirectory(prefix="pdum-ws-", dir="/tmp") as directory:
        socket_path = f"{directory}/backend.sock"
        async with unix_serve(echo, socket_path):
            async with open_relay(f"unix://{socket_path}", host="127.0.0.1") as relay:
                async with connect(relay.endpoint, proxy=None) as first, connect(relay.endpoint, proxy=None) as second:
                    await first.send('{"id":1,"value":"first"}')
                    await second.send('{"id":1,"value":"second"}')
                    assert "first" in await first.recv()
                    assert "second" in await second.recv()


class SlowProcessor:
    def __init__(self):
        self.gate = asyncio.Event()
        self.started = asyncio.Event()

    async def open(self):
        pass

    async def process(self, observation):
        self.started.set()
        await self.gate.wait()

    async def close(self):
        pass


class FailingProcessor(SlowProcessor):
    async def process(self, observation):
        raise OSError("sink unavailable")


class CanceledProcessor(SlowProcessor):
    async def process(self, observation):
        raise asyncio.CancelledError


async def test_slow_and_failed_processors_do_not_gate_forwarding(tmp_path):
    slow = SlowProcessor()
    capture_path = tmp_path / "healthy.jsonl"
    async with serve(echo, "127.0.0.1", 0) as upstream:
        endpoint = f"ws://127.0.0.1:{upstream.sockets[0].getsockname()[1]}"
        async with open_relay(endpoint, processors=[slow, FailingProcessor(), JsonlRecorder(capture_path)]) as relay:
            async with connect(relay.endpoint, proxy=None) as client:
                for number in range(10):
                    await client.send(str(number))
                    assert await asyncio.wait_for(client.recv(), 1) == str(number)
            await slow.started.wait()
            status = await relay.status()
            assert status["processors"][0]["pending"] > 0
            assert "sink unavailable" in status["processors"][1]["error"]
            slow.gate.set()
    assert len(capture_path.read_text().splitlines()) == 20


async def test_upstream_failure_closes_client():
    async with open_relay("unix:///nonexistent/pdum-codex-test.sock", host="127.0.0.1") as relay:
        async with connect(relay.endpoint, proxy=None) as client:
            await asyncio.wait_for(client.wait_closed(), 2)
            assert client.close_code == 1011
        assert (await relay.status())["transport_errors"] == 1


async def test_shutdown_accounts_for_slow_observer():
    slow = SlowProcessor()
    observer = Observer((slow,), close_timeout=0.05)
    await observer.start()
    observer.submit(Observation("run", "connection", 1, "client_to_server", "hello"))
    await slow.started.wait()
    await observer.aclose()
    assert observer.status()[0]["lost"] == 1
    assert observer.status()[0]["pending"] == 0
    assert "timed out" in observer.status()[0]["error"]


async def test_existing_capture_is_not_overwritten(tmp_path):
    path = tmp_path / "existing.jsonl"
    path.write_text("preserve\n")
    recorder = JsonlRecorder(path)
    with pytest.raises(FileExistsError):
        await recorder.open()
    assert path.read_text() == "preserve\n"


async def test_self_canceled_processor_does_not_accumulate_unconsumed_messages():
    observer = Observer((CanceledProcessor(),))
    await observer.start()
    observer.submit(Observation("run", "connection", 1, "client_to_server", "first"))
    async with asyncio.timeout(2):
        while not observer.status()[0]["error"]:
            await asyncio.sleep(0)
    for sequence in range(2, 20):
        observer.submit(Observation("run", "connection", sequence, "client_to_server", "next"))
    await observer.aclose()
    assert observer.status()[0]["pending"] == 0
    assert observer.status()[0]["lost"] == 19


def test_observation_byte_count_is_utf8_not_characters():
    assert Observation("run", "connection", 1, "client_to_server", "λ").byte_count == 2


async def test_backend_close_reason_is_preserved():
    async def backend(connection):
        await connection.close(4001, "Application finished")

    async with serve(backend, "127.0.0.1", 0) as upstream:
        endpoint = f"ws://127.0.0.1:{upstream.sockets[0].getsockname()[1]}"
        async with open_relay(endpoint, host="127.0.0.1") as relay:
            async with connect(relay.endpoint, proxy=None) as client:
                await asyncio.wait_for(client.wait_closed(), 2)
                assert client.close_code == 4001
                assert client.close_reason == "Application finished"

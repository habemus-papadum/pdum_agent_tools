"""No-provider byte-transport checks using real subprocesses and WebSockets."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

from aiohttp import ClientSession
from client import Client
from server import Owner, serve


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="spike068-transport-")
        self.owner = Owner(Path(self.temp.name))
        self.runner, self.url = await serve(self.owner)
        self.http = ClientSession()
        self.clients = []

    async def asyncTearDown(self):
        for client in self.clients:
            if not client.closed:
                await client.close()
        await self.http.close()
        await self.runner.cleanup()
        self.temp.cleanup()

    async def attach(self, session):
        client = await Client(self.http, f"{self.url}/sessions/{session.id}/feed").connect()
        self.clients.append(client)
        return client

    async def test_opaque_stdin_not_parsed_or_rewritten(self):
        program = (
            "import sys,base64,json\n"
            "for line in sys.stdin.buffer:\n"
            ' print(json.dumps({"received":base64.b64encode(line).decode()}),flush=True)\n'
        )
        session = await self.owner.launch(command=[sys.executable, "-u", "-c", program])
        a, b = await self.attach(session), await self.attach(session)
        payload = b"  definitely not JSON: \xff\x00\n"
        await a.ws.send_bytes(payload)
        await b.until(lambda: bool(b.frames))
        self.assertEqual(base64.b64decode(b.frames[0]["received"]), payload)
        self.assertTrue(all(e["direction"] == "stdout" for e in b.events if e["kind"] == "output"))
        recorded = [e for e in session.entries if e["direction"] == "stdin"]
        self.assertEqual(base64.b64decode(recorded[0]["data"]), payload)

    async def test_attach_during_output_has_complete_ordered_bytes(self):
        program = (
            "import sys,time,json\n"
            "for i in range(100):\n"
            ' data=(json.dumps({"i":i,"text":"\\u03bb"},ensure_ascii=False)+"\\n").encode()\n'
            " for byte in data: sys.stdout.buffer.write(bytes([byte]));sys.stdout.buffer.flush()\n"
            " time.sleep(.002)\n"
        )
        session = await self.owner.launch(command=[sys.executable, "-u", "-c", program])
        for _ in range(10):
            await self.attach(session)
            await asyncio.sleep(0.008)
        await asyncio.wait_for(session.exited.wait(), 10)
        for client in self.clients:
            await client.until(lambda: any(e["kind"] == "process-exit" for e in client.events))
        expected = b"".join(base64.b64decode(e["data"]) for e in session.entries if e["direction"] == "stdout")
        for client in self.clients:
            self.assertEqual(client.raw, expected)
            self.assertEqual([f["i"] for f in client.frames], list(range(100)))
            seqs = [e["seq"] for e in client.events if e["kind"] == "output"]
            self.assertEqual(seqs, sorted(set(seqs)))
            boundary = next(i for i, e in enumerate(client.events) if e["kind"] == "replay-end")
            high_water = client.events[boundary]["highWater"]
            self.assertTrue(all(e["seq"] <= high_water for e in client.events[:boundary] if e["kind"] == "output"))
            self.assertTrue(all(e["seq"] > high_water for e in client.events[boundary + 1 :] if e["kind"] == "output"))
            self.assertEqual(client.events[-1]["kind"], "process-exit")

    async def test_stalled_journal_does_not_stall_forwarding(self):
        program = "import sys\nfor line in sys.stdin.buffer: sys.stdout.buffer.write(line);sys.stdout.buffer.flush()\n"
        session = await self.owner.launch(command=[sys.executable, "-u", "-c", program])
        session.writer.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await session.writer
        a = await self.attach(session)
        await a.ws.send_str('{"realProducerEcho":true}\n')
        await a.until(lambda: bool(a.frames), timeout=3)
        self.assertTrue(a.frames[0]["realProducerEcho"])
        self.assertGreater(session.status()["journalBacklog"], 0)
        session.writer = asyncio.create_task(session._write_journal())
        await session.disk.join()
        self.assertEqual(session.status()["journalBacklog"], 0)

    async def test_large_exit_tail_precedes_exit_marker(self):
        payload = {"data": "z" * (2 * 1024 * 1024)}
        program = 'import json\nprint(json.dumps({"data":"z"*(2*1024*1024)}),flush=True)\n'
        session = await self.owner.launch(command=[sys.executable, "-u", "-c", program])
        client = await self.attach(session)
        await client.until(lambda: any(e["kind"] == "process-exit" for e in client.events), timeout=10)
        self.assertEqual(client.frames, [payload])
        self.assertEqual(client.events[-1]["kind"], "process-exit")
        late = await self.attach(session)
        await late.until(lambda: any(e["kind"] == "process-exit" for e in late.events))
        self.assertEqual(late.raw, client.raw)
        self.assertEqual(late.events[-1]["kind"], "process-exit")
        await session.close()
        recorded = [json.loads(line) for line in session.journal_path.read_text().splitlines()]
        self.assertEqual(recorded, session.entries)


if __name__ == "__main__":
    unittest.main()

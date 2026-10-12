import asyncio
import base64
import gzip
import ipaddress
import json
import os
import signal
import ssl
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import aiohttp
import httpx
import pytest
import pytest_asyncio
import typer
from aiohttp import web
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from pdum.mitm import ProcessorSpec, SidecarConfig, SidecarFailure, open_sidecar
from pdum.mitm.cli import _processor_spec, create_app
from pdum.mitm.processors import JsonlProcessor
from rich.text import Text
from typer import rich_utils
from typer.testing import CliRunner


@pytest.fixture
def tls_files(tmp_path):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(UTC) - timedelta(days=1))
        .not_valid_after(datetime.now(UTC) + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
            critical=False,
        )
        .sign(private_key, hashes.SHA256())
    )
    key_path = tmp_path / "upstream-key.pem"
    cert_path = tmp_path / "upstream-cert.pem"
    key_path.write_bytes(
        private_key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()
        )
    )
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path


@pytest_asyncio.fixture
async def local_server(tls_files):
    seen = []
    release_stream = asyncio.Event()

    async def echo(request):
        content = await request.read()
        seen.append({"headers": list(request.headers.items()), "body": content})
        return web.Response(body=content or b"hello", headers={"X-Echo": "yes"})

    async def websocket(request):
        seen.append({"origin": request.headers.get("Origin")})
        socket = web.WebSocketResponse(max_msg_size=0, compress=True)
        await socket.prepare(request)
        async for message in socket:
            if message.type == aiohttp.WSMsgType.TEXT:
                await socket.send_str(message.data)
            elif message.type == aiohttp.WSMsgType.BINARY:
                await socket.send_bytes(message.data)
        return socket

    async def stream(request):
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        await response.write(b'data: {"first":true}\n\n')
        await release_stream.wait()
        await response.write(b'data: {"second":true}\n\n')
        await response.write_eof()
        return response

    async def compressed(request):
        return web.Response(
            body=gzip.compress(b'{"first":1}\n{"second":2}\n', mtime=0),
            headers={"Content-Type": "application/x-ndjson", "Content-Encoding": "gzip"},
        )

    application = web.Application(client_max_size=10 * 1024 * 1024)
    application.router.add_route("*", "/echo", echo)
    application.router.add_get("/ws", websocket)
    application.router.add_get("/stream", stream)
    application.router.add_get("/compressed", compressed)
    runner = web.AppRunner(application)
    await runner.setup()
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(*tls_files)
    plain_site = web.TCPSite(runner, "127.0.0.1", 0)
    tls_site = web.TCPSite(runner, "127.0.0.1", 0, ssl_context=tls)
    await plain_site.start()
    await tls_site.start()
    try:
        yield {
            "http": f"http://127.0.0.1:{plain_site._server.sockets[0].getsockname()[1]}",
            "https": f"https://localhost:{tls_site._server.sockets[0].getsockname()[1]}",
            "seen": seen,
            "release_stream": release_stream,
            "cert": tls_files[0],
        }
    finally:
        release_stream.set()
        await runner.cleanup()


def read_records(directory: Path) -> list[dict]:
    return [json.loads(line) for line in (directory / "records.jsonl").read_text().splitlines()]


async def test_real_http_https_capture_and_scoped_environment(tmp_path, local_server):
    source_environment = {"SSL_CERT_FILE": str(local_server["cert"]), "NO_PROXY": "keep.example"}
    config = SidecarConfig(capture_dir=tmp_path / "captures", recording=True, upstream_ca=local_server["cert"])
    async with open_sidecar(config) as handle:
        worker_pid = handle.pid
        ca = handle.connection.ca_cert_path
        environment = handle.connection.environment(source_environment)
        assert source_environment == {"SSL_CERT_FILE": str(local_server["cert"]), "NO_PROXY": "keep.example"}
        assert environment["https_proxy"] == handle.connection.proxy_url
        assert environment["NO_PROXY"] == "keep.example,localhost,127.0.0.1,::1"
        bundle = Path(environment["SSL_CERT_FILE"]).read_bytes()
        assert local_server["cert"].read_bytes() in bundle
        assert ca.read_bytes() in bundle
        tls = ssl.create_default_context(cafile=environment["SSL_CERT_FILE"])
        async with httpx.AsyncClient(proxy=handle.connection.proxy_url, verify=tls, trust_env=False) as client:
            plain = await client.get(local_server["http"] + "/echo")
            assert plain.content == b"hello"
            content = b'{"credential":"deliberately-preserved-test-value"}'
            secure = await client.post(
                local_server["https"] + "/echo",
                content=content,
                headers=[("X-Duplicate", "first"), ("X-Duplicate", "second")],
            )
            assert secure.content == content
        flushed = await handle.flush()
        assert flushed["complete"]
        assert json.loads((handle.capture_path / "manifest.json").read_text())["complete"] is False
        assert flushed["bytes_written"] > 0
        records = read_records(handle.capture_path)
        bodies = b"".join(
            base64.b64decode(record["data_base64"]) for record in records if record["kind"] == "http_body"
        )
        assert bodies.count(content) == 2
        request = next(record for record in records if record.get("method") == "POST")
        assert [value for name, value in request["headers"] if name.lower() == "x-duplicate"] == ["first", "second"]
        archive = handle.capture_path
    assert not ca.exists()
    with pytest.raises(ProcessLookupError):
        os.kill(worker_pid, 0)
    manifest = json.loads((archive / "manifest.json").read_text())
    assert manifest["complete"]
    assert await handle.wait_failure() is None
    assert (await handle.aclose())["complete"]


async def test_real_wss_toggle_on_existing_connection_large_binary(tmp_path, local_server):
    config = SidecarConfig(capture_dir=tmp_path / "captures", upstream_ca=local_server["cert"])
    async with open_sidecar(config) as handle:
        tls = ssl.create_default_context(cafile=str(handle.connection.ca_cert_path))
        async with aiohttp.ClientSession() as client:
            async with client.ws_connect(
                local_server["https"].replace("https:", "wss:") + "/ws",
                proxy=handle.connection.proxy_url,
                ssl=tls,
                origin="https://trusted-browser.example",
                max_msg_size=0,
                compress=15,
            ) as socket:
                await socket.send_str("not recorded")
                assert (await socket.receive()).data == "not recorded"
                assert not handle.capture_path.exists()
                ack = await handle.configure_capture(True, expected_revision=0)
                assert ack["revision"] == 1
                with pytest.raises(RuntimeError, match="revision conflict"):
                    await handle.configure_capture(True, expected_revision=0)
                payload = bytes(range(256)) * 5000
                await socket.send_bytes(payload)
                assert (await socket.receive()).data == payload
                await socket.send_str('{"unknown-event":"recorded","token":"test-token"}')
                assert (await socket.receive()).type == aiohttp.WSMsgType.TEXT
                await handle.configure_capture(False, expected_revision=1)
                await socket.send_str("also not recorded")
                assert (await socket.receive()).data == "also not recorded"
        assert (await handle.flush())["complete"]
        records = read_records(handle.capture_path)
        messages = [record for record in records if record["kind"] == "websocket_message"]
        assert len(messages) == 4
        assert [base64.b64decode(record["data_base64"]) for record in messages[:2]] == [payload, payload]
        assert messages[2]["json"]["token"] == "test-token"
        assert any(record["kind"] == "flow_snapshot" and record["missing_prefix"] for record in records)
        assert not any("not recorded" in record.get("text", "") for record in records)
        assert local_server["seen"][0]["origin"] == "https://trusted-browser.example"
        assert (await handle.status())["websocket_messages"] == 8


async def test_streaming_is_forwarded_before_response_completion(tmp_path, local_server):
    async with open_sidecar(SidecarConfig(capture_dir=tmp_path, recording=True)) as handle:
        async with httpx.AsyncClient(proxy=handle.connection.proxy_url, trust_env=False) as client:
            async with client.stream("GET", local_server["http"] + "/stream") as response:
                chunks = response.aiter_bytes()
                first = await asyncio.wait_for(anext(chunks), 3)
                assert b'"first":true' in first
                await handle.flush()
                records = read_records(handle.capture_path)
                assert any(record["kind"] == "http_body" for record in records)
                local_server["release_stream"].set()
                rest = b"".join([chunk async for chunk in chunks])
                assert b'"second":true' in rest


async def test_encoded_http_payload_is_preserved_without_decoding_limits(tmp_path, local_server):
    async with open_sidecar(SidecarConfig(capture_dir=tmp_path, recording=True)) as handle:
        async with httpx.AsyncClient(proxy=handle.connection.proxy_url, trust_env=False) as client:
            response = await client.get(local_server["http"] + "/compressed")
            assert response.content == b'{"first":1}\n{"second":2}\n'
        await handle.flush()
        records = read_records(handle.capture_path)
        payload = b"".join(
            base64.b64decode(record["data_base64"])
            for record in records
            if record["kind"] == "http_body" and record["direction"] == "response"
        )
        assert payload == gzip.compress(response.content, mtime=0)


async def test_real_tls_missing_client_trust_and_untrusted_upstream(tmp_path, local_server):
    async with open_sidecar(SidecarConfig(upstream_ca=local_server["cert"])) as handle:
        async with httpx.AsyncClient(proxy=handle.connection.proxy_url, trust_env=False) as client:
            with pytest.raises(httpx.ConnectError):
                await client.get(local_server["https"] + "/echo")
    async with open_sidecar() as handle:
        tls = ssl.create_default_context(cafile=str(handle.connection.ca_cert_path))
        async with httpx.AsyncClient(proxy=handle.connection.proxy_url, verify=tls, trust_env=False) as client:
            response = await client.get(local_server["https"] + "/echo")
            assert response.status_code == 502


async def test_processor_failure_does_not_break_forwarding_or_archive(tmp_path, local_server):
    occupied = tmp_path / "occupied.jsonl"
    occupied.write_text("do not overwrite\n")
    healthy = tmp_path / "extra.jsonl"
    processors = [
        ProcessorSpec("pdum.mitm.processors:JsonlProcessor", {"path": str(occupied)}, name="failing"),
        ProcessorSpec("pdum.mitm.processors:JsonlProcessor", {"path": str(healthy)}, name="healthy"),
    ]
    async with open_sidecar(
        SidecarConfig(capture_dir=tmp_path / "captures", recording=True), processors=processors
    ) as handle:
        async with httpx.AsyncClient(proxy=handle.connection.proxy_url, trust_env=False) as client:
            assert (await client.get(local_server["http"] + "/echo")).content == b"hello"
            assert (await client.get(local_server["http"] + "/echo")).content == b"hello"
        flushed = await handle.flush()
        assert not flushed["complete"]
        assert flushed["processors"]["failing"]["error"]
        assert flushed["processors"]["healthy"]["error"] is None
        assert flushed["processors"]["archive"]["error"] is None
        assert healthy.read_text() == (handle.capture_path / "records.jsonl").read_text()
        assert occupied.read_text() == "do not overwrite\n"


async def test_fatal_worker_exit_is_observable_and_reaped():
    async with open_sidecar() as handle:
        os.kill(handle.pid, signal.SIGKILL)
        failure = await asyncio.wait_for(handle.wait_failure(), 5)
        assert isinstance(failure, SidecarFailure)
        assert "exited" in str(failure) or "closed unexpectedly" in str(failure)


@pytest.mark.parametrize("method", ["process", "flush"])
async def test_processor_cancellation_is_reported_without_killing_dispatch(tmp_path, local_server, monkeypatch, method):
    monkeypatch.setenv("PYTHONPATH", str(Path(__file__).parent))
    processor = ProcessorSpec("processor_examples:CancelledProcessor", {"method": method}, name="cancelled")
    config = SidecarConfig(capture_dir=tmp_path / "captures", recording=True)
    async with open_sidecar(config, processors=[processor]) as handle:
        async with httpx.AsyncClient(proxy=handle.connection.proxy_url, trust_env=False) as client:
            assert (await client.get(local_server["http"] + "/echo")).content == b"hello"
        result = await handle.flush()
        assert not result["complete"]
        assert "CancelledError" in result["processors"]["cancelled"]["error"]
        assert result["processors"]["archive"]["error"] is None
        assert (await handle.flush())["processors"]["cancelled"]["pending"] == 0


async def test_slow_observation_flush_does_not_block_health_control(tmp_path, local_server, monkeypatch):
    monkeypatch.setenv("PYTHONPATH", str(Path(__file__).parent))
    processor = ProcessorSpec("processor_examples:SlowFlushProcessor", name="slow")
    config = SidecarConfig(capture_dir=tmp_path, recording=True)
    async with open_sidecar(config, processors=[processor]) as handle:
        first_flush = asyncio.create_task(handle.flush())
        second_flush = asyncio.create_task(handle.flush())
        await asyncio.sleep(0.05)
        started = time.monotonic()
        assert (await handle.status())["state"] == "ready"
        assert time.monotonic() - started < 0.5
        async with httpx.AsyncClient(proxy=handle.connection.proxy_url, trust_env=False) as client:
            assert (await client.get(local_server["http"] + "/echo")).content == b"hello"
        first_result = await first_flush
        assert first_result["complete"]
        assert first_result["through_seq"] < (await handle.status())["sequence"]
        assert (await second_flush)["complete"]


async def test_local_writer_separates_buffered_and_durable_watermarks(tmp_path):
    writer = JsonlProcessor(tmp_path / "observations.jsonl")
    await writer.process({"seq": 1, "payload": "test"})
    assert writer.written_seq == 1
    assert writer.persisted_seq == 0
    await writer.flush()
    assert writer.persisted_seq == 1
    await writer.aclose()


async def test_parent_control_eof_exits_worker():
    async with open_sidecar() as handle:
        handle.process.stdin.close()
        assert await asyncio.wait_for(handle.process.wait(), 5) == 0


async def test_crashed_capture_retains_incomplete_manifest(tmp_path, local_server):
    async with open_sidecar(SidecarConfig(capture_dir=tmp_path, recording=True)) as handle:
        async with httpx.AsyncClient(proxy=handle.connection.proxy_url, trust_env=False) as client:
            await client.get(local_server["http"] + "/echo")
        await handle.flush()
        archive = handle.capture_path
        os.kill(handle.pid, signal.SIGKILL)
        await handle.wait_failure()
    assert json.loads((archive / "manifest.json").read_text())["complete"] is False


async def test_fixed_port_conflict_fails_cleanly():
    async with open_sidecar(SidecarConfig(bind_host="127.0.0.1")) as existing:
        port = int(existing.connection.proxy_url.rsplit(":", 1)[1])
        with pytest.raises(SidecarFailure, match="listen|address|Address"):
            async with open_sidecar(SidecarConfig(bind_host="127.0.0.1", port=port, startup_timeout=4)):
                pytest.fail("occupied listener started")
        assert (await existing.status())["state"] == "ready"


async def test_cancellation_reaps_proxy():
    ready = asyncio.Event()
    handles = []

    async def application():
        async with open_sidecar() as handle:
            handles.append(handle)
            ready.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(application())
    await ready.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert handles[0].process.returncode == 0
    assert not handles[0].connection.ca_cert_path.exists()


async def test_cancellation_during_close_waits_for_owned_child(tmp_path, monkeypatch):
    monkeypatch.setenv("PYTHONPATH", str(Path(__file__).parent))
    processor = ProcessorSpec("processor_examples:SlowFlushProcessor")
    async with open_sidecar(SidecarConfig(capture_dir=tmp_path, recording=True), processors=[processor]) as handle:
        closing = asyncio.create_task(handle.aclose())
        await asyncio.sleep(0.05)
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing
        assert handle.process.returncode == 0
        assert not handle.connection.ca_cert_path.exists()


@pytest.mark.parametrize("force_terminal", [False, True], ids=["plain", "ansi"])
def test_cli_is_mountable_and_factories_are_independent(monkeypatch, force_terminal):
    monkeypatch.setattr(rich_utils, "FORCE_TERMINAL", force_terminal)
    monkeypatch.setenv("TERM", "xterm-256color")
    monkeypatch.delenv("NO_COLOR", raising=False)
    parent = typer.Typer()
    parent.add_typer(create_app(), name="proxy")
    result = CliRunner().invoke(parent, ["proxy", "run", "--help"])
    assert result.exit_code == 0
    assert ("\x1b[" in result.output) is force_terminal
    assert "capture-dir" in Text.from_ansi(result.output).plain
    result = CliRunner().invoke(create_app(), ["run", "--record"])
    assert result.exit_code != 0
    assert "requires capture_dir" in Text.from_ansi(result.output).plain
    assert create_app() is not create_app()
    with pytest.raises(ValueError, match="collides"):
        create_app(providers={"run": typer.Typer()})
    assert _processor_spec('pdum.mitm.processors:JsonlProcessor={"path":"out.jsonl"}').config == {"path": "out.jsonl"}
    with pytest.raises(ValueError, match="JSON object"):
        _processor_spec("module:factory=[]")

"""Private JSONL-controlled mitmproxy process; not a general public CLI."""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

from mitmproxy import http, options, version
from mitmproxy.tools.dump import DumpMaster

from ._observation import Observer


def send(value: dict) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class Capture:
    def __init__(self, observer: Observer, config: dict):
        self.observer = observer
        self.config = config
        self.recording = config["recording"]
        self.revision = 0
        self.sequence = 0
        self.flows: dict[str, dict] = {}
        self.total_payload_bytes = 0
        self.flow_count = 0
        self.websocket_messages = 0
        self.ready = asyncio.Event()

    def emit(self, kind: str, flow_id: str | None = None, payload: bytes | None = None, **metadata) -> None:
        if not self.recording:
            return
        self.sequence += 1
        self.observer.submit(
            {
                "schema": "pdum.mitm.capture/1",
                "run_id": self.config["run_id"],
                "seq": self.sequence,
                "revision": self.revision,
                "timestamp": time.time(),
                "monotonic": time.monotonic(),
                "kind": kind,
                "flow_id": flow_id,
                **metadata,
            },
            payload,
        )

    def running(self) -> None:
        self.ready.set()

    def _stream(self, flow_id: str, direction: str):
        def stream(chunk: bytes) -> bytes:
            self.total_payload_bytes += len(chunk)
            if chunk:
                self.emit("http_body", flow_id, chunk, direction=direction)
            return chunk

        return stream

    def requestheaders(self, flow: http.HTTPFlow) -> None:
        metadata = {
            "method": flow.request.method,
            "url": flow.request.pretty_url,
            "http_version": flow.request.http_version,
            "headers": tuple(
                (name.decode("latin-1"), value.decode("latin-1")) for name, value in flow.request.headers.fields
            ),
        }
        self.flow_count += 1
        self.flows[flow.id] = {"request": metadata}
        self.emit("http_request", flow.id, **metadata)
        flow.request.stream = self._stream(flow.id, "request")

    def request(self, flow: http.HTTPFlow) -> None:
        self.emit("http_request_end", flow.id)

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        metadata = {
            "status": flow.response.status_code,
            "http_version": flow.response.http_version,
            "headers": tuple(
                (name.decode("latin-1"), value.decode("latin-1")) for name, value in flow.response.headers.fields
            ),
        }
        self.flows.setdefault(flow.id, {})["response"] = metadata
        self.emit("http_response", flow.id, **metadata)
        if flow.response.status_code != 101:
            flow.response.stream = self._stream(flow.id, "response")

    def response(self, flow: http.HTTPFlow) -> None:
        self.emit("http_response_end", flow.id)
        if flow.response.status_code != 101:
            self.flows.pop(flow.id, None)

    def websocket_start(self, flow: http.HTTPFlow) -> None:
        self.emit("websocket_start", flow.id)

    def websocket_message(self, flow: http.HTTPFlow) -> None:
        message = flow.websocket.messages[-1]
        self.websocket_messages += 1
        self.total_payload_bytes += len(message.content)
        self.emit(
            "websocket_message",
            flow.id,
            bytes(message.content),
            direction="request" if message.from_client else "response",
            opcode=message.type.name,
        )
        flow.websocket.messages.clear()

    def websocket_end(self, flow: http.HTTPFlow) -> None:
        self.emit("websocket_end", flow.id, close_code=flow.websocket.close_code)
        self.flows.pop(flow.id, None)

    def error(self, flow: http.HTTPFlow) -> None:
        self.emit("flow_error", flow.id, error=str(flow.error))
        self.flows.pop(flow.id, None)

    def configure(self, enabled: bool, expected: int | None) -> dict:
        if expected is not None and expected != self.revision:
            raise ValueError(f"revision conflict: expected {expected}, current {self.revision}")
        if enabled and self.config["archive"] is None:
            raise ValueError("recording requires capture_dir at launch")
        was_recording = self.recording
        self.revision += 1
        self.recording = was_recording or enabled
        self.emit("capture_state", enabled=enabled)
        self.recording = enabled
        if enabled and not was_recording:
            for flow_id, metadata in self.flows.items():
                self.emit("flow_snapshot", flow_id, missing_prefix=True, **metadata)
        return {"revision": self.revision, "boundary_seq": self.sequence, "recording": enabled}

    def status(self) -> dict:
        return {
            "state": "ready",
            "recording": self.recording,
            "revision": self.revision,
            "sequence": self.sequence,
            "flows": self.flow_count,
            "active_flows": len(self.flows),
            "websocket_messages": self.websocket_messages,
            "observed_payload_bytes": self.total_payload_bytes,
            "engine": f"mitmproxy {version.VERSION}",
            "pid": os.getpid(),
            **self.observer.status(),
        }


async def main() -> None:
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    config = json.loads(await reader.readline())
    observer = Observer(Path(config["archive"]) if config["archive"] else None, config["run_id"], config["processors"])
    await asyncio.wrap_future(observer.ready)
    engine_options = options.Options(
        listen_host=config["bind_host"],
        listen_port=config["port"],
        confdir=config["confdir"],
        ssl_insecure=False,
        ignore_hosts=config["ignore_hosts"],
    )
    master = DumpMaster(engine_options, with_termlog=False, with_dumper=False)
    if config["upstream_ca"]:
        master.options.update(ssl_verify_upstream_trusted_ca=config["upstream_ca"])
    capture = Capture(observer, config)
    master.addons.add(capture)

    async def run_engine() -> None:
        try:
            await master.run()
        except SystemExit as error:
            checker = master.addons.get("errorcheck")
            details = "; ".join(record.getMessage() for record in checker.logger.has_errored)
            raise RuntimeError(details or f"proxy engine startup exited with status {error.code}") from None

    engine = asyncio.create_task(run_engine())
    readiness = asyncio.create_task(capture.ready.wait())
    done, _ = await asyncio.wait((engine, readiness), return_when=asyncio.FIRST_COMPLETED)
    if engine in done:
        await engine
        raise RuntimeError("proxy engine stopped before readiness")
    servers = master.addons.get("proxyserver").servers
    addresses = [address for server in servers for address in server.listen_addrs]
    if not addresses:
        raise RuntimeError("proxy has no listening socket")
    ca = Path(config["confdir"]) / "mitmproxy-ca-cert.pem"
    if not ca.is_file():
        raise RuntimeError("proxy CA certificate was not generated")
    send({"ready": True, "port": addresses[0][1], "ca_cert_path": str(ca), "engine": version.VERSION})
    if capture.recording:
        capture.emit("capture_state", enabled=True)
    pending_flushes: set[asyncio.Task] = set()

    async def respond_flush(request_id: int) -> None:
        try:
            result = await observer.flush(config["control_timeout"])
            send({"id": request_id, "result": result})
        except Exception as error:
            send({"id": request_id, "error": f"{type(error).__name__}: {error}"})

    try:
        while True:
            line_task = asyncio.create_task(reader.readline())
            done, _ = await asyncio.wait((line_task, engine), return_when=asyncio.FIRST_COMPLETED)
            if engine in done:
                line_task.cancel()
                await engine
                raise RuntimeError("proxy engine exited unexpectedly")
            line = line_task.result()
            if not line:
                break
            request = json.loads(line)
            try:
                command = request["command"]
                if command == "status":
                    result = capture.status()
                elif command == "configure":
                    result = capture.configure(request["enabled"], request.get("expected_revision"))
                elif command == "flush":
                    task = asyncio.create_task(respond_flush(request["id"]))
                    pending_flushes.add(task)
                    task.add_done_callback(pending_flushes.discard)
                    continue
                elif command == "close":
                    for flow_id in capture.flows:
                        capture.emit("flow_incomplete", flow_id, reason="sidecar shutdown")
                    master.shutdown()
                    await engine
                    result = await observer.close(config["shutdown_timeout"])
                    send({"id": request["id"], "result": result})
                    return
                else:
                    raise ValueError(f"unknown control command: {command}")
                send({"id": request["id"], "result": result})
            except Exception as error:
                send({"id": request["id"], "error": f"{type(error).__name__}: {error}"})
    finally:
        for task in pending_flushes:
            task.cancel()
        await asyncio.gather(*pending_flushes, return_exceptions=True)
        master.shutdown()
        await engine
        await observer.close(config["shutdown_timeout"])


if __name__ == "__main__":
    os.umask(0o077)
    try:
        asyncio.run(main())
    except Exception as failure:
        send({"fatal": f"{type(failure).__name__}: {failure}"})
        raise SystemExit(1) from None

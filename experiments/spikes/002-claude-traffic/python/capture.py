import gzip
import hashlib
import json
import os
import re
import time
import zlib
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from mitmproxy import http


SECRET_KEYS = {
    "authorization", "proxy-authorization", "x-api-key", "api_key", "apikey",
    "cookie", "set-cookie", "access_token", "refresh_token", "id_token",
    "password", "secret", "token", "api-key", "credentials",
}


def redact(value):
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if key.lower() in SECRET_KEYS else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str) and (secret := os.environ.get("SPIKE_REDACT_SECRET")):
        return value.replace(secret, "[REDACTED]")
    return value


def safe_url(value):
    parts = urlsplit(value)
    query = urlencode([
        (key, "[REDACTED]" if key.lower() in SECRET_KEYS else item)
        for key, item in parse_qsl(parts.query, keep_blank_values=True)
    ])
    return urlunsplit((parts.scheme, parts.netloc.split("@")[-1], parts.path, query, ""))


class Writer:
    def __init__(self, path, maximum):
        self.output = os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb")
        self.maximum = maximum
        self.written = 0
        self.dropped = 0

    def write(self, **event):
        encoded = (json.dumps(redact({"time": time.time(), **event}), ensure_ascii=False) + "\n").encode()
        if self.written + len(encoded) > self.maximum:
            self.dropped += 1
            return
        self.output.write(encoded)
        self.output.flush()
        self.written += len(encoded)


class Body:
    def __init__(self, owner, flow, direction, message):
        self.owner = owner
        self.flow = flow
        self.direction = direction
        self.encoding = message.headers.get("content-encoding", "identity")
        self.is_sse = "text/event-stream" in message.headers.get("content-type", "")
        self.content = bytearray()
        self.pending = bytearray()
        self.total = 0
        self.digest = hashlib.sha256()
        self.sse_count = 0
        self.decoded_bytes = 0
        self.decode_truncated = False
        self.decoder = zlib.decompressobj(31 if self.encoding == "gzip" else 15) if self.is_sse and self.encoding in ("gzip", "deflate") else None

    def __call__(self, chunk):
        self.total += len(chunk)
        self.digest.update(chunk)
        remaining = max(0, self.owner.body_limit - len(self.content))
        captured = chunk[:remaining]
        self.content.extend(captured)
        if self.is_sse and self.encoding in ("identity", "gzip", "deflate"):
            available = max(0, self.owner.body_limit - self.decoded_bytes)
            if self.decoder:
                try:
                    decoded = self.decoder.decompress(chunk, available + 1)
                except zlib.error:
                    decoded = b""
                    self.encoding = "invalid-compression"
            else:
                decoded = captured if not self.decoder else b""
            self.decode_truncated |= len(decoded) > available
            decoded = decoded[:available]
            self.decoded_bytes += len(decoded)
            self.pending.extend(decoded)
            while match := re.search(rb"\r?\n\r?\n", self.pending):
                frame = bytes(self.pending[:match.start()])
                del self.pending[:match.end()]
                lines = frame.decode("utf-8", errors="replace").splitlines()
                event = next((line[6:].strip() for line in lines if line.startswith("event:")), "message")
                data = "\n".join(line[5:].lstrip(" ") for line in lines if line.startswith("data:"))
                if not data:
                    continue
                try:
                    data = json.loads(data)
                except ValueError:
                    pass
                self.owner.writer.write(kind="sse", flow_id=self.flow.id, event=event, data=data)
                self.sse_count += 1
        return chunk

    def finish(self):
        truncated = self.total > self.owner.body_limit or self.decode_truncated
        value = None
        decode_error = None
        if not truncated and not self.is_sse:
            content = bytes(self.content)
            try:
                if self.encoding == "gzip":
                    import io
                    with gzip.GzipFile(fileobj=io.BytesIO(content)) as reader:
                        content = reader.read(self.owner.body_limit + 1)
                    if len(content) > self.owner.body_limit:
                        truncated = True
                        content = b""
                elif self.encoding != "identity":
                    raise ValueError("unsupported content encoding")
                if content:
                    value = json.loads(content)
            except (ValueError, OSError):
                decode_error = "non-JSON or unsupported encoding; body omitted"
        self.owner.writer.write(
            kind=f"{self.direction}_body", flow_id=self.flow.id, bytes=self.total,
            sha256=self.digest.hexdigest(), truncated=truncated, body=value,
            content_encoding=self.encoding, decode_error=decode_error,
            sse_events=self.sse_count,
            sse_decode_supported=not self.is_sse or self.encoding in ("identity", "gzip", "deflate"),
        )


class Capture:
    def __init__(self):
        self.directory = Path(os.environ["SPIKE_CAPTURE_DIR"])
        self.body_limit = int(os.environ.get("SPIKE_BODY_LIMIT", "1048576"))
        self.writer = Writer(self.directory / "level2.jsonl", int(os.environ.get("SPIKE_FILE_LIMIT", "33554432")))
        self.fixture_port = os.environ.get("SPIKE_FIXTURE_PORT")
        self.bodies = {}
        self.websocket_count = 0

    def requestheaders(self, flow: http.HTTPFlow):
        self.writer.write(
            kind="request", flow_id=flow.id, method=flow.request.method,
            url=safe_url(flow.request.pretty_url), http_version=flow.request.http_version,
            headers=dict(flow.request.headers),
        )
        body = Body(self, flow, "request", flow.request)
        self.bodies[(flow.id, "request")] = body
        flow.request.stream = body
        if self.fixture_port:
            if flow.request.host != "fixture.agent-spike.invalid":
                flow.response = http.Response.make(403, b"Fixture mode blocks non-fixture destinations")
            else:
                flow.request.host = "127.0.0.1"
                flow.request.port = int(self.fixture_port)
                flow.request.scheme = "http"

    def request(self, flow):
        if body := self.bodies.pop((flow.id, "request"), None):
            body.finish()

    def responseheaders(self, flow):
        self.writer.write(
            kind="response", flow_id=flow.id, status=flow.response.status_code,
            http_version=flow.response.http_version, headers=dict(flow.response.headers),
            tls_version=flow.client_conn.tls_version,
            alpn=(flow.client_conn.alpn or b"").decode(errors="replace"),
        )
        if flow.response.status_code != 101:
            body = Body(self, flow, "response", flow.response)
            self.bodies[(flow.id, "response")] = body
            flow.response.stream = body

    def response(self, flow):
        if body := self.bodies.pop((flow.id, "response"), None):
            body.finish()

    def websocket_message(self, flow):
        message = flow.websocket.messages[-1]
        payload = message.content
        value = None
        if len(payload) <= self.body_limit:
            try:
                value = json.loads(payload)
            except ValueError:
                value = None
        self.writer.write(
            kind="websocket", flow_id=flow.id, from_client=message.from_client,
            opcode=message.type.name, bytes=len(payload), body=value,
            truncated=len(payload) > self.body_limit,
            sha256=hashlib.sha256(payload).hexdigest(),
        )
        self.websocket_count += 1
        flow.websocket.messages.clear()

    def error(self, flow):
        self.writer.write(kind="error", flow_id=flow.id, error=flow.error.msg if flow.error else None)
        for direction in ("request", "response"):
            if body := self.bodies.pop((flow.id, direction), None):
                body.finish()

    def done(self):
        self.writer.output.close()
        with os.fdopen(os.open(self.directory / "capture-stats.json", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as output:
            json.dump({"bytes_written": self.writer.written, "events_dropped": self.writer.dropped, "websocket_messages": self.websocket_count}, output)


addons = [Capture()] if "SPIKE_CAPTURE_DIR" in os.environ else []

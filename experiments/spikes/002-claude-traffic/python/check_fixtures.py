import json
import gzip
import os
from pathlib import Path
import socket
import ssl
import sys
import zlib
from types import SimpleNamespace

from capture import Body, Writer


port = int(sys.argv[1])
directory = Path(sys.argv[2])
certificate = directory / "ca/mitmproxy-ca-cert.pem"


def connect(trusted=True):
    connection = socket.create_connection(("127.0.0.1", port), timeout=10)
    connection.sendall(b"CONNECT fixture.agent-spike.invalid:443 HTTP/1.1\r\nHost: fixture.agent-spike.invalid:443\r\n\r\n")
    response = b""
    while b"\r\n\r\n" not in response:
        response += connection.recv(1)
    assert b"200" in response
    context = ssl.create_default_context(cafile=str(certificate) if trusted else None)
    return context.wrap_socket(connection, server_hostname="fixture.agent-spike.invalid")


def request(path, body=None):
    with connect() as connection:
        payload = json.dumps(body).encode() if body is not None else b""
        method = "POST" if body is not None else "GET"
        connection.sendall(f"{method} {path} HTTP/1.1\r\nHost: fixture.agent-spike.invalid\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {len(payload)}\r\nAuthorization: Bearer fixture-auth-secret\r\nX-Api-Key: fixture-api-secret\r\nCookie: fixture-cookie-secret\r\n\r\n".encode() + payload)
        response = bytearray()
        while chunk := connection.recv(4096):
            response.extend(chunk)
        assert b"200" in response[:40]


try:
    with connect(False):
        raise AssertionError("TLS must fail without the run-local CA")
except ssl.SSLCertVerificationError:
    pass

request("/json?access_token=fixture-query-secret", {"secret": "fixture-body-secret", "value": "ok"})
request("/v1/messages", {"model": "fixture-model", "messages": [], "stream": True})
request("/v1/messages?compressed", {"model": "fixture-model", "messages": [], "stream": True})
request("/large", {"value": "x" * 1_100_000})

with connect() as connection:
    connection.sendall(b"GET /websocket HTTP/1.1\r\nHost: fixture.agent-spike.invalid\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
    response = b""
    while b"\r\n\r\n" not in response:
        response += connection.recv(1)
    assert b"101" in response
    payload = b'{"value":"fixture-ws","token":"fixture-ws-secret"}'
    mask = os.urandom(4)
    encoded = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    connection.sendall(bytes([0x81, 0x80 | len(payload)]) + mask + encoded)
    response = connection.recv(4096)
    assert b"fixture-ws" in response

writer = Writer(directory / "budget-check.jsonl", 256)
writer.write(kind="small", value="ok")
writer.write(kind="large", value="x" * 512)
assert writer.dropped == 1 and writer.written <= 256
writer.output.close()

writer = Writer(directory / "gzip-bound-check.jsonl", 4096)
owner = SimpleNamespace(writer=writer, body_limit=256)
body = Body(owner, SimpleNamespace(id="gzip-expansion"), "request", SimpleNamespace(headers={"content-encoding": "gzip"}))
body(gzip.compress(b"x" * 4096))
body.finish()
writer.output.close()
assert json.loads((directory / "gzip-bound-check.jsonl").read_text())["truncated"]

writer = Writer(directory / "gzip-boundary-check.jsonl", 4096)
owner = SimpleNamespace(writer=writer, body_limit=256)
body = Body(owner, SimpleNamespace(id="gzip-exact-boundary"), "response", SimpleNamespace(headers={"content-encoding": "gzip", "content-type": "text/event-stream"}))
compressor = zlib.compressobj(wbits=31)
body(compressor.compress(b"x" * 256) + compressor.flush(zlib.Z_SYNC_FLUSH))
assert body.decoded_bytes == 256 and not body.decode_truncated
body(compressor.compress(b"y") + compressor.flush())
assert body.total < 256 and body.decode_truncated
body.finish()
writer.output.close()
assert json.loads((directory / "gzip-boundary-check.jsonl").read_text())["truncated"]

print(json.dumps({"https": True, "untrusted_ca_rejected": True, "json": True, "sse": True, "gzip_sse": True, "websocket": True, "large_body": True, "file_budget": True, "gzip_expansion_bound": True, "gzip_exact_boundary": True}))

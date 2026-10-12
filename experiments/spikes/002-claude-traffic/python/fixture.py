import base64
import gzip
import hashlib
import json
import struct
import sys
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def events(model):
    return [
        {"type": "message_start", "message": {"id": "msg_fixture", "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 0}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "SPIKE_FIXTURE_OK"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 4}},
        {"type": "message_stop"},
    ]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        request = json.loads(body or b"{}")
        if self.path.split("?")[0] == "/v1/messages":
            compressed = "compressed" in self.path
            compressor = zlib.compressobj(wbits=31) if compressed else None
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            if compressed:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Set-Cookie", "fixture-response-secret")
            self.end_headers()
            for event in events(request.get("model", "fixture-model")):
                data = f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode()
                if compressor:
                    data = compressor.compress(data) + compressor.flush(zlib.Z_SYNC_FLUSH)
                self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                self.wfile.flush()
                time.sleep(0.05)
            if compressor:
                data = compressor.flush()
                self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        else:
            self.respond({"ok": True, "access_token": "fixture-response-secret"})

    def do_GET(self):
        if self.headers.get("Upgrade", "").lower() == "websocket":
            accept = base64.b64encode(hashlib.sha1((self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            header = self.rfile.read(2)
            length = header[1] & 127
            if length == 126:
                length = struct.unpack("!H", self.rfile.read(2))[0]
            mask = self.rfile.read(4)
            payload = self.rfile.read(length)
            payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
            self.wfile.write(bytes([0x81, len(payload)]) + payload)
            self.wfile.write(b"\x88\x00")
            self.wfile.flush()
            self.close_connection = True
        else:
            self.respond({"ok": True})

    def respond(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


server = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler)
server.serve_forever()

import base64
import gzip
import hashlib
import json
import struct
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4


def tool_named(tools, name, namespace=None):
    for tool in tools:
        if tool.get("name") == name:
            return tool, namespace
        found = tool_named(tool.get("tools", []), name, tool.get("name"))
        if found:
            return found
    return None


def model_events(request):
    identifier = f"resp_{uuid4().hex}"
    inputs = request.get("input", [])
    user_text = "\n".join(
        part.get("text", "")
        for item in inputs if item.get("role") == "user"
        for part in item.get("content", []) if isinstance(part, dict)
    )
    spawn = tool_named(request.get("tools", []), "spawn_agent")
    is_parent = "SPIKE_PARENT_SPAWN" in user_text
    is_child = "SPIKE_CHILD_REQUEST" in user_text and not is_parent
    already_spawned = any(item.get("type") == "function_call_output" for item in inputs)
    if is_parent and not already_spawned and spawn:
        tool, namespace = spawn
        properties = tool.get("parameters", {}).get("properties", {})
        arguments = {"message": "SPIKE_CHILD_REQUEST: reply with CHILD_OK and use no tools."}
        if "task_name" in properties:
            arguments.update(task_name="traffic_child", fork_turns="none")
        if "fork_context" in properties:
            arguments["fork_context"] = False
        item = {"type": "function_call", "id": "fc_spike_spawn", "call_id": "spike_spawn", "name": "spawn_agent", "arguments": json.dumps(arguments)}
        if namespace:
            item["namespace"] = namespace
    else:
        text = "CHILD_OK" if is_child else "PARENT_OK" if is_parent else "REGULAR_OK"
        item = {"type": "message", "role": "assistant", "id": f"msg_{uuid4().hex}", "content": [{"type": "output_text", "text": text}]}
    return [
        {"type": "response.created", "response": {"id": identifier}},
        {"type": "response.output_item.done", "item": item},
        {"type": "response.completed", "response": {"id": identifier, "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2, "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}}},
    ]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.headers.get("Upgrade", "").lower() == "websocket":
            self.websocket()
        else:
            data = b'{"data":[]}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    def do_POST(self):
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            chunks = []
            while size := int(self.rfile.readline().strip(), 16):
                chunks.append(self.rfile.read(size))
                self.rfile.read(2)
            self.rfile.readline()
            payload = b"".join(chunks)
        else:
            payload = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.headers.get("Content-Encoding") == "gzip":
            payload = gzip.decompress(payload)
        request = json.loads(payload)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for event in model_events(request):
            data = f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode()
            self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            self.wfile.flush()
            if event["type"] != "response.completed":
                time.sleep(0.02)
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def send_frame(self, payload, opcode=1):
        length = len(payload)
        header = bytes([0x80 | opcode, length]) if length < 126 else bytes([0x80 | opcode, 126]) + struct.pack("!H", length) if length < 65536 else bytes([0x80 | opcode, 127]) + struct.pack("!Q", length)
        self.wfile.write(header + payload)
        self.wfile.flush()

    def websocket(self):
        accept = base64.b64encode(hashlib.sha1((self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.close_connection = True
        pending = bytearray()
        history = []
        tools = []
        while header := self.rfile.read(2):
            if len(header) != 2:
                return
            opcode = header[0] & 15
            length = header[1] & 127
            if length in (126, 127):
                length = struct.unpack("!H" if length == 126 else "!Q", self.rfile.read(2 if length == 126 else 8))[0]
            if length > 4 * 1024 * 1024:
                return
            mask = self.rfile.read(4) if header[1] & 128 else None
            payload = self.rfile.read(length)
            if mask:
                payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
            if opcode == 8:
                self.send_frame(b"", 8)
                return
            if opcode == 9:
                self.send_frame(payload, 10)
                continue
            pending.extend(payload)
            if not header[0] & 128:
                continue
            request = json.loads(pending)
            pending.clear()
            if request.get("previous_response_id"):
                history += request.get("input", [])
                request["input"] = history
            else:
                history = list(request.get("input", []))
            tools = request.get("tools", tools)
            request["tools"] = tools
            for event in model_events(request):
                self.send_frame(json.dumps(event).encode())


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler)
    server.serve_forever()

"""Real local MCP tool whose four-second wait makes its pending state inspectable."""

import json
import sys
import time

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    if method == "initialize":
        result = {
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "spike032-health", "version": "0.0.0"},
        }
    elif method == "tools/list":
        result = {
            "tools": [
                {
                    "name": "health_wait",
                    "description": "Wait four seconds locally and return MCP_DONE.",
                    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
                }
            ]
        }
    elif method == "tools/call":
        time.sleep(4)
        result = {"content": [{"type": "text", "text": "MCP_DONE"}], "isError": False}
    elif method in ("resources/list", "prompts/list"):
        result = {method.split("/")[0]: []}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)

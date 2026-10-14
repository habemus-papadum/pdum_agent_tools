"""Serve the tiny browser client through the existing production relay."""

import argparse
import asyncio
import functools
import http.server
import json
import os
import shutil
import socket
import tempfile
import threading
from pathlib import Path

from pdum.codex_launcher.relay import Relay


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default="/Users/nehal/.local/bin/codex")
    parser.add_argument("--auth", action="store_true", help="Copy existing file-backed login into disposable home")
    args = parser.parse_args()
    base = Path(tempfile.mkdtemp(prefix="pdum030-browser-"))
    home, work = base / "home", base / "work"
    home.mkdir()
    work.mkdir()
    if args.auth:
        source = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "auth.json"
        shutil.copyfile(source, home / "auth.json")
        (home / "auth.json").chmod(0o600)
    upstream_port = port()
    env = dict(os.environ, HOME=str(home), CODEX_HOME=str(home))
    process = await asyncio.create_subprocess_exec(
        args.binary,
        "app-server",
        "--listen",
        f"ws://127.0.0.1:{upstream_port}",
        "-c",
        'sandbox_mode="danger-full-access"',
        "-c",
        'approval_policy="never"',
        "-c",
        'model="gpt-6-luna"',
        "-c",
        'model_reasoning_effort="low"',
        "-c",
        "analytics.enabled=false",
        "-c",
        "feedback.enabled=false",
        "-c",
        "features.apps=false",
        "-c",
        "features.plugins=false",
        "-c",
        "skills.bundled.enabled=false",
        cwd=work,
        env=env,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    relay = Relay(f"ws://127.0.0.1:{upstream_port}")
    await relay.start("127.0.0.1", 0)
    webroot = base / "web"
    webroot.mkdir()
    html = Path(__file__).with_name("browser.html").read_text()
    (webroot / "index.html").write_text(
        html.replace("__CONFIG__", json.dumps({"endpoint": relay.endpoint, "cwd": str(work), "auth": args.auth}))
    )
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(webroot))
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(
        json.dumps(
            {
                "url": f"http://127.0.0.1:{server.server_port}/",
                "relay": relay.endpoint,
                "cwd": str(work),
                "home": str(home),
                "nativePid": process.pid,
                "auth": args.auth,
            }
        ),
        flush=True,
    )
    try:
        await asyncio.Event().wait()
    finally:
        server.shutdown()
        await relay.aclose()
        if process.returncode is None:
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=3)
        except TimeoutError:
            process.kill()
            await process.wait()
        shutil.rmtree(base)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

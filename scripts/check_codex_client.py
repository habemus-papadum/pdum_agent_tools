"""Exercise the real Codex remote TUI in an isolated pseudoterminal."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import fcntl
import json
import os
import pty
import re
import shutil
import signal
import struct
import tempfile
import termios
from pathlib import Path


async def check_client(
    endpoint: str,
    *,
    binary: str,
    timeout: float = 20,
    expected: str = "Sign in with ChatGPT",
    prompt: str | None = None,
    completion: asyncio.Event | None = None,
    thread_id: str | None = None,
) -> dict[str, object]:
    """Wait for real TUI output without changing the operator's client state.

    Parameters
    ----------
    endpoint
        Running native or relayed app-server endpoint.
    binary
        Codex executable to run.
    timeout
        Maximum seconds to wait for the expected terminal text.
    expected
        Text confirming the requested stage was reached.
    prompt
        Optional actual prompt. Omit for the default, non-inference login probe.
    completion
        Optional externally observed protocol completion. When provided, keep
        the terminal alive until this event and the expected text are both seen.
    thread_id
        Resume this existing remote thread instead of creating a new one.
        Pre-naming the thread can avoid native automatic title-generation calls.

    Returns
    -------
    dict
        Small, capture-free diagnostic summary. Terminal data stays in memory.
    """
    with tempfile.TemporaryDirectory(prefix="pdum-client-") as directory:
        root = Path(directory)
        home = root / "home"
        codex_home = root / "codex"
        home.mkdir()
        codex_home.mkdir()
        environment = {
            "PATH": os.environ.get("PATH", os.defpath),
            "HOME": str(home),
            "CODEX_HOME": str(codex_home),
            "TERM": "xterm-256color",
        }
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        os.set_blocking(master, False)
        command = [binary, "--remote", endpoint, "--no-alt-screen"]
        if thread_id is not None:
            command.extend(["resume", thread_id])
        if prompt is not None:
            command.append(prompt)
        process = None
        terminal_bytes = bytearray()
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                env=environment,
                cwd=root,
                start_new_session=True,
            )
            os.close(slave)
            slave = -1
            async with asyncio.timeout(timeout):
                pending_query = b""
                expected_seen = False
                while True:
                    await asyncio.sleep(0.02)
                    try:
                        chunk = os.read(master, 65536)
                    except BlockingIOError:
                        if expected_seen and (completion is None or completion.is_set()):
                            break
                        if process.returncode is not None:
                            raise RuntimeError(f"Codex TUI exited before expected output: {process.returncode}")
                        continue
                    except OSError as error:
                        raise RuntimeError("Codex TUI closed its terminal before expected output") from error
                    terminal_bytes.extend(chunk)
                    queries = pending_query + chunk
                    for _ in range(queries.count(b"\x1b[6n")):
                        os.write(master, b"\x1b[1;1R")
                    pending_query = queries[-3:]
                    text = terminal_bytes.decode("utf-8", errors="replace")
                    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
                    expected_seen = expected in text
                    if expected_seen and (completion is None or completion.is_set()):
                        break
            return {
                "connected": True,
                "expected_output_seen": True,
                "terminal_bytes": len(terminal_bytes),
                "inference_requested": prompt is not None,
            }
        finally:
            if slave != -1:
                os.close(slave)
            if process is not None:
                if process.returncode is None:
                    with contextlib.suppress(OSError):
                        os.write(master, b"\x03")
                    try:
                        await asyncio.wait_for(process.wait(), 1)
                    except TimeoutError:
                        with contextlib.suppress(ProcessLookupError):
                            os.killpg(process.pid, signal.SIGTERM)
                        try:
                            await asyncio.wait_for(process.wait(), 3)
                        except TimeoutError:
                            with contextlib.suppress(ProcessLookupError):
                                os.killpg(process.pid, signal.SIGKILL)
                            await process.wait()
            os.close(master)


def main() -> None:
    """Run the opt-in client compatibility check."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("endpoint")
    parser.add_argument("--binary", default=shutil.which("codex"))
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--expect", default="Sign in with ChatGPT")
    parser.add_argument("--prompt", help="Send a real prompt; may incur model usage on the server")
    parser.add_argument("--thread-id", help="Resume an existing remote thread instead of creating one")
    arguments = parser.parse_args()
    if not arguments.binary:
        parser.error("Codex not found; provide --binary")
    result = asyncio.run(
        check_client(
            arguments.endpoint,
            binary=arguments.binary,
            timeout=arguments.timeout,
            expected=arguments.expect,
            prompt=arguments.prompt,
            thread_id=arguments.thread_id,
        )
    )
    print(json.dumps(result))


if __name__ == "__main__":
    main()

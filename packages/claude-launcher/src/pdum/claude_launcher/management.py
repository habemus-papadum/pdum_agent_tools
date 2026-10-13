"""Optional FastAPI routes over an application-owned Claude manager."""

from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .errors import LauncherError
from .observation import ObservationHub, UsageObserver
from .runtime import ClaudeManager, LaunchOptions
from .storage import History, HistoryError


def create_app(
    manager: ClaudeManager,
    *,
    observer: ObservationHub | None = None,
    usage: UsageObserver | None = None,
    worker_environment: dict[str, str] | None = None,
    example_directory: Path | None = None,
):
    """Create routes without launching workers or taking over their lifecycle.

    Parameters
    ----------
    manager
        Existing foreground manager owned by the calling application.
    observer, usage
        Optional inspection status surfaces, independent of the relay.
    worker_environment
        Host-selected scoped environment, for example an optional MITM sidecar.
    example_directory
        Optional directory containing the built browser example.

    Returns
    -------
    FastAPI
        HTTP management and WebSocket relay adapter. Its lifespan owns only its
        lazily created storage helpers; the caller closes the manager and observers.
    """
    try:
        from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import JSONResponse
        from fastapi.staticfiles import StaticFiles
    except ImportError:
        raise RuntimeError("Install habemus-papadum-claude-launcher[management] to serve HTTP") from None

    # FastAPI resolves local annotation names from the function's globals.
    globals().update(Request=Request, WebSocket=WebSocket)
    histories: dict[str, History] = {}

    @asynccontextmanager
    async def lifespan(app):
        try:
            yield
        finally:
            import asyncio

            await asyncio.gather(*(history.close() for history in histories.values()))

    app = FastAPI(title="Claude launcher management", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    def profile(profile_id: str):
        try:
            return manager.profiles[profile_id]
        except KeyError:
            raise HTTPException(404, "Unknown profile") from None

    def history(profile_id: str) -> History:
        selected = profile(profile_id)
        if profile_id not in histories or histories[profile_id].closed:
            histories[profile_id] = History(selected)
        return histories[profile_id]

    def worker_status(worker_id: str, request: Request) -> dict[str, Any]:
        try:
            value = manager.worker(worker_id).status()
        except KeyError:
            raise HTTPException(404, "Unknown worker") from None
        value["profileId"] = value.pop("profile_id")
        value["conversationId"] = value.pop("conversation_id")
        base = str(request.base_url).rstrip("/")
        websocket_base = ("wss://" + base[8:]) if base.startswith("https://") else ("ws://" + base[7:])
        value["websocketUrl"] = f"{websocket_base}/workers/{quote(worker_id, safe='')}"
        return value

    @app.exception_handler(HistoryError)
    async def history_error(request: Request, error: HistoryError):
        return JSONResponse(status_code=502, content={"detail": "Native history operation failed"})

    @app.exception_handler(ValueError)
    async def invalid_history_operation(request: Request, error: ValueError):
        return JSONResponse(status_code=422, content={"detail": "Invalid native history operation"})

    @app.exception_handler(FileNotFoundError)
    async def missing_history(request: Request, error: FileNotFoundError):
        return JSONResponse(status_code=404, content={"detail": "Saved conversation not found"})

    @app.exception_handler(TimeoutError)
    async def history_timeout(request: Request, error: TimeoutError):
        return JSONResponse(
            status_code=504, content={"detail": "History helper timed out; operation outcome may be unknown"}
        )

    @app.get("/api/profiles")
    async def profiles():
        return [
            {
                "id": name,
                "directory": str(selected.directory),
                "workspace": str(selected.workspace),
                "model": selected.model,
                "settingSources": selected.setting_sources,
                "authentication": selected.auth.method,
            }
            for name, selected in manager.profiles.items()
        ]

    @app.get("/api/status")
    async def status(request: Request):
        return {
            "workers": [worker_status(value["id"], request) for value in manager.list_workers()],
            "observation": observer.status() if observer else [],
            "usage": usage.status() if usage else None,
        }

    @app.get("/api/workers")
    async def workers(request: Request):
        return [worker_status(value["id"], request) for value in manager.list_workers()]

    @app.post("/api/workers", status_code=201)
    async def allocate(request: Request, body: dict[str, Any]):
        profile_id = body.get("profileId")
        if not isinstance(profile_id, str):
            raise HTTPException(422, "profileId must be a string")
        profile(profile_id)
        resume = body.get("resume")
        if resume is not None:
            if not isinstance(resume, str):
                raise HTTPException(422, "resume must be a conversation ID")
            if await history(profile_id).info(resume) is None:
                raise HTTPException(404, "Conversation not found in this profile/workspace")
        options_data = body.get("options", {})
        if not isinstance(options_data, dict):
            raise HTTPException(422, "options must be an object")
        allowed = {"model", "permission_mode", "sandbox", "tools", "max_turns", "max_budget_usd"}
        if set(options_data) - allowed:
            raise HTTPException(422, "Unsupported launch option")
        if "tools" in options_data:
            tools = options_data["tools"]
            if not isinstance(tools, list) or not all(isinstance(tool, str) for tool in tools):
                raise HTTPException(422, "tools must be an array of strings")
            options_data["tools"] = tuple(tools)
        for key in ("model", "permission_mode"):
            if key in options_data and (not isinstance(options_data[key], str) or not options_data[key]):
                raise HTTPException(422, f"{key} must be a nonempty string")
        if "sandbox" in options_data and not isinstance(options_data["sandbox"], bool):
            raise HTTPException(422, "sandbox must be a boolean")
        for key in ("max_turns", "max_budget_usd"):
            if key in options_data and (
                isinstance(options_data[key], bool) or not isinstance(options_data[key], (int, float))
            ):
                raise HTTPException(422, f"{key} must be a number")
        if "max_turns" in options_data and not isinstance(options_data["max_turns"], int):
            raise HTTPException(422, "max_turns must be an integer")
        try:
            options = replace(LaunchOptions(**options_data), environment=worker_environment or {})
            allocated = await manager.allocate(profile_id, resume=resume, options=options)
        except (TypeError, ValueError):
            raise HTTPException(422, "Invalid launch options or conversation ID") from None
        except RuntimeError:
            raise HTTPException(503, "Manager is stopping") from None
        return worker_status(allocated.id, request)

    @app.get("/api/workers/{worker_id}")
    async def get_worker(worker_id: str, request: Request):
        return worker_status(worker_id, request)

    @app.delete("/api/workers/{worker_id}")
    async def stop_worker(worker_id: str, request: Request):
        worker_status(worker_id, request)
        await manager.stop(worker_id)
        return worker_status(worker_id, request)

    @app.websocket("/workers/{worker_id}")
    async def relay(websocket: WebSocket, worker_id: str):
        try:
            selected = manager.worker(worker_id)
        except KeyError:
            await websocket.close(code=1008)
            return
        if selected.state != "waiting":
            await websocket.close(code=1008)
            return
        await websocket.accept()

        async def receive():
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return None
            return message.get("text") if message.get("text") is not None else message.get("bytes")

        async def close(code: int, reason: str):
            try:
                await websocket.close(code=code, reason=reason)
            except (WebSocketDisconnect, RuntimeError):
                pass

        try:
            await manager.bridge(worker_id, receive, websocket.send_text, close)
        except (WebSocketDisconnect, LauncherError, RuntimeError, OSError):
            await close(1011, "Worker connection ended; inspect worker status")

    @app.get("/api/profiles/{profile_id}/sessions")
    async def sessions(profile_id: str):
        return await history(profile_id).list()

    async def session_exists(profile_id: str, session_id: str):
        info = await history(profile_id).info(session_id)
        if info is None:
            raise HTTPException(404, "Conversation not found in this profile/workspace")
        return info

    @app.get("/api/profiles/{profile_id}/sessions/{session_id}")
    async def read_session(profile_id: str, session_id: str):
        info = await session_exists(profile_id, session_id)
        return {"info": info, "messages": await history(profile_id).read(session_id)}

    @app.patch("/api/profiles/{profile_id}/sessions/{session_id}")
    async def rename_session(profile_id: str, session_id: str, body: dict[str, Any]):
        await session_exists(profile_id, session_id)
        if not isinstance(body.get("title"), str):
            raise HTTPException(422, "title must be a string")
        await history(profile_id).rename(session_id, body["title"])
        return await history(profile_id).info(session_id)

    @app.post("/api/profiles/{profile_id}/sessions/{session_id}/fork", status_code=201)
    async def fork_session(profile_id: str, session_id: str, body: dict[str, Any]):
        await session_exists(profile_id, session_id)
        for key in ("title", "upToMessageId"):
            if body.get(key) is not None and not isinstance(body[key], str):
                raise HTTPException(422, f"{key} must be a string")
        return await history(profile_id).fork(
            session_id, title=body.get("title"), up_to_message_id=body.get("upToMessageId")
        )

    if example_directory is not None:
        app.mount("/example", StaticFiles(directory=example_directory, html=True), name="example")
    return app

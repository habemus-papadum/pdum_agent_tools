"""Optional HTTP adapter over an already-owned coordinator."""

from __future__ import annotations

from typing import Any

from .runtime import Coordinator, InstanceMismatchError


def create_app(coordinator: Coordinator) -> Any:
    """Create management routes without starting a listener or acquiring ownership.

    Parameters
    ----------
    coordinator
        Owner started and closed by the calling application.

    Returns
    -------
    FastAPI
        Status, current-run listing and targeted stop-request routes.
    """
    try:
        from fastapi import FastAPI, HTTPException
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import JSONResponse
        from starlette.background import BackgroundTask
    except ImportError:
        raise RuntimeError("Install habemus-papadum-orchestrator[management] to serve HTTP") from None

    app = FastAPI(title="Agent host coordinator", version="0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.get("/api/status")
    async def status() -> dict[str, Any]:
        return coordinator.status()

    @app.get("/api/runs")
    async def runs() -> dict[str, Any]:
        return {"runs": coordinator.list_runs()}

    @app.post("/api/stop")
    async def stop(body: dict[str, Any]):
        instance_id = body.get("instanceId")
        if not isinstance(instance_id, str):
            raise HTTPException(422, "instanceId must identify the coordinator to stop")
        try:
            coordinator.verify_instance(instance_id)
        except InstanceMismatchError as error:
            raise HTTPException(409, str(error)) from None

        async def request_stop() -> None:
            coordinator.request_stop(instance_id)

        # Finish this response before asking the foreground owner to close HTTP.
        return JSONResponse(
            {"instanceId": instance_id, "accepted": True},
            background=BackgroundTask(request_stop),
        )

    return app

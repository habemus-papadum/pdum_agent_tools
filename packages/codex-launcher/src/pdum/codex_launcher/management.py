"""Optional FastAPI routes over an already-owned app-server instance."""

from typing import Annotated, Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from .errors import LauncherError
from .runtime import RunningAppServer


class CaptureChange(BaseModel):
    """A strict recording-state change; interception must already be running."""

    model_config = ConfigDict(extra="forbid")

    enabled: StrictBool
    expected_revision: Annotated[int, Field(strict=True, ge=0)] | None = None


def create_app(server: RunningAppServer) -> FastAPI:
    """Adapt an existing server's management methods without taking ownership.

    Parameters
    ----------
    server
        An application-owned, already-launched app-server. The calling application
        still controls its async context and the HTTP listener's lifetime.

    Returns
    -------
    FastAPI
        Mountable trusted-network management routes: ``GET /status``,
        ``POST /capture`` and ``POST /stop``. Capture conflicts/unavailable
        interception return 409, invalid request bodies 422, and I/O/timeouts 503.
        Stop returns only after the existing owner's cleanup finishes. App
        creation and HTTP lifespan events neither launch nor close the server.
    """
    application = FastAPI(title="pdum Codex management", version="1")

    @application.get("/status")
    async def status() -> dict[str, Any]:
        try:
            return await server.status()
        except (OSError, TimeoutError) as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @application.post("/capture")
    async def capture(change: CaptureChange) -> dict[str, Any]:
        try:
            return await server.configure_capture(change.enabled, expected_revision=change.expected_revision)
        except (LauncherError, RuntimeError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except (OSError, TimeoutError) as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @application.post("/stop")
    async def stop() -> dict[str, bool]:
        try:
            await server.aclose()
        except (OSError, TimeoutError) as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        return {"stopped": True}

    return application

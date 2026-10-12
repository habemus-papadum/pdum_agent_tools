"""Generic asyncio-managed HTTP(S)/WebSocket interception and observation."""

from .config import ProcessorSpec, SidecarConfig
from .environment import ProxyConnection
from .sidecar import SidecarFailure, SidecarHandle, open_sidecar

__all__ = ["ProcessorSpec", "ProxyConnection", "SidecarConfig", "SidecarFailure", "SidecarHandle", "open_sidecar"]

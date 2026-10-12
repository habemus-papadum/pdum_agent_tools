"""Configuration for the managed, generic interception sidecar."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ProcessorSpec:
    """Select an importable processor factory and its keyword configuration.

    Parameters
    ----------
    factory
        Import reference in ``module:attribute`` form. Called with ``config``.
    config
        JSON-serializable keyword arguments passed to the factory.
    name
        Optional unique name for status reporting.
    """

    factory: str
    config: dict[str, Any] = field(default_factory=dict)
    name: str | None = None


@dataclass(frozen=True)
class SidecarConfig:
    """Configure immutable proxy launch settings and initial recording state.

    Parameters
    ----------
    capture_dir
        Parent directory for a unique run archive. Required to enable recording.
    recording
        Start recording immediately rather than intercepting without capture.
    bind_host, port
        Listener address. Port zero asks the engine to allocate a port.
    advertised_host
        Optional host returned to consumers instead of a local connect address.
    upstream_ca
        Additional CA bundle trusted by the proxy for upstream TLS connections.
    ignore_hosts
        mitmproxy host-pattern exclusions. Excluded TLS is tunneled, not captured.
    work_dir
        Parent directory for disposable worker state and CA material.
    startup_timeout, control_timeout, shutdown_timeout
        Process/control deadlines in seconds, not client connection lifetimes.
    """

    capture_dir: Path | None = None
    recording: bool = False
    bind_host: str = "0.0.0.0"
    port: int = 0
    advertised_host: str | None = None
    upstream_ca: Path | None = None
    ignore_hosts: tuple[str, ...] = ()
    work_dir: Path | None = None
    startup_timeout: float = 15.0
    control_timeout: float = 10.0
    shutdown_timeout: float = 5.0

    def __post_init__(self) -> None:
        if not 0 <= self.port <= 65535:
            raise ValueError("port must be between 0 and 65535")
        if not self.bind_host:
            raise ValueError("bind_host must not be empty")
        if self.recording and self.capture_dir is None:
            raise ValueError("recording requires capture_dir")
        if min(self.startup_timeout, self.control_timeout, self.shutdown_timeout) <= 0:
            raise ValueError("timeouts must be positive")

"""Portable request and result records, independent of Linux implementation details."""

from __future__ import annotations

import dataclasses
import math
from datetime import timedelta
from pathlib import Path
from typing import Any, Literal


def seconds(value: float | timedelta | None) -> float | None:
    """Normalize a duration, rejecting negative and non-finite values."""
    if value is None:
        return None
    number = value.total_seconds() if isinstance(value, timedelta) else float(value)
    if not math.isfinite(number) or number < 0:
        raise ValueError("Durations must be finite and nonnegative")
    return number


def json_value(value: Any) -> Any:
    """Convert public records to JSON-compatible values without platform objects."""
    if dataclasses.is_dataclass(value):
        return {field.name: json_value(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, timedelta):
        return value.total_seconds()
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    return value


@dataclasses.dataclass(frozen=True)
class PrivateTree:
    """A private tree derived from a source path or registered baseline.

    Parameters
    ----------
    source, baseline
        Exactly one input for nonempty trees. Baselines are borrowed by default.
    storage
        Explicit storage mechanism; no fallback changes its guarantees.
    pool
        Name of the configured allocation root.
    stable
        Operator assertion that an overlay lower remains stable through retention.
    """

    source: Path | str | None = None
    baseline: str | None = None
    storage: Literal["copy", "overlay", "btrfs", "empty"] = "copy"
    pool: str = "default"
    stable: bool = False

    def __post_init__(self) -> None:
        if self.storage not in ("copy", "overlay", "btrfs", "empty"):
            raise ValueError(f"Unknown storage mechanism: {self.storage}")
        inputs = int(self.source is not None) + int(self.baseline is not None)
        if inputs != (0 if self.storage == "empty" else 1):
            raise ValueError("Nonempty trees need exactly one source or baseline; empty trees have neither")
        if not self.pool:
            raise ValueError("A storage pool name is required")


@dataclasses.dataclass(frozen=True)
class HostView:
    """Inherit the host and explicitly replace selected paths.

    Parameters
    ----------
    replace
        Workload-visible absolute path to named private tree.
    read_only
        Existing paths protected through recursive read-only bind mounts.
    shared
        Workload-visible path to live host source path.
    fresh
        Existing paths replaced by owned persistent empty directories.
    """

    replace: dict[str, str] = dataclasses.field(default_factory=dict)
    read_only: tuple[str, ...] = ()
    shared: dict[str, str] = dataclasses.field(default_factory=dict)
    fresh: tuple[str, ...] = ()


@dataclasses.dataclass(frozen=True)
class WorkspaceView:
    """Expose one named private tree at its allocated workspace path."""

    tree: str


@dataclasses.dataclass(frozen=True)
class Limits:
    """Aggregate kernel-accounted memory and CPU budget for an environment."""

    memory_bytes: int | None = None
    cpu_cores: float | None = None

    def __post_init__(self) -> None:
        if self.memory_bytes is not None and (
            isinstance(self.memory_bytes, bool) or not isinstance(self.memory_bytes, int) or self.memory_bytes <= 0
        ):
            raise ValueError("memory_bytes must be a positive integer")
        if self.cpu_cores is not None and (not math.isfinite(self.cpu_cores) or self.cpu_cores <= 0):
            raise ValueError("cpu_cores must be finite and positive")


@dataclasses.dataclass(frozen=True)
class Lifetime:
    """Fixed execution budget including stop grace, and creator-loss policy.

    Parameters
    ----------
    max_runtime
        Seconds or timedelta from scope activation to force-stop; None is unbounded.
    owner_exit
        Stop on creator loss, or continue until expiry/explicit stop.
    grace_seconds
        Graceful termination budget inside max_runtime.
    setup_timeout
        Bound for cooperative setup operations before runtime activation.
    """

    max_runtime: float | timedelta | None = None
    owner_exit: Literal["stop", "continue"] = "stop"
    grace_seconds: float = 0.5
    setup_timeout: float = 30.0

    def __post_init__(self) -> None:
        maximum = seconds(self.max_runtime)
        grace = seconds(self.grace_seconds)
        setup = seconds(self.setup_timeout)
        if self.owner_exit not in ("stop", "continue"):
            raise ValueError("owner_exit must be stop or continue")
        if maximum is not None and (maximum <= 0 or grace >= maximum):
            raise ValueError("max_runtime must be positive and larger than termination grace")
        if setup <= 0:
            raise ValueError("setup_timeout must be positive")


@dataclasses.dataclass(frozen=True)
class Retention:
    """Retention after confirmed execution stop; None retains indefinitely."""

    trees: float | timedelta | None = None
    evidence: float | timedelta | None = None

    def __post_init__(self) -> None:
        seconds(self.trees)
        seconds(self.evidence)


@dataclasses.dataclass(frozen=True)
class EnvironmentSpec:
    """Portable environment request; unavailable backend features are explicit."""

    trees: dict[str, PrivateTree] = dataclasses.field(default_factory=dict)
    view: HostView | WorkspaceView = dataclasses.field(default_factory=HostView)
    limits: Limits = dataclasses.field(default_factory=Limits)
    lifetime: Lifetime = dataclasses.field(default_factory=Lifetime)
    retention: Retention = dataclasses.field(default_factory=Retention)
    labels: dict[str, str] = dataclasses.field(default_factory=dict)

    def to_dict(self) -> dict:
        """Serialize the request for CLI files and durable records."""
        value = json_value(self)
        value["view"]["kind"] = "host" if isinstance(self.view, HostView) else "workspace"
        return value

    @classmethod
    def from_dict(cls, value: dict) -> EnvironmentSpec:
        """Parse the same request schema used by the Python API."""
        data = dict(value)
        data["trees"] = {name: PrivateTree(**tree) for name, tree in data.get("trees", {}).items()}
        view = dict(data.get("view", {}))
        kind = view.pop("kind", "host")
        if kind not in ("host", "workspace"):
            raise ValueError(f"Unknown view: {kind}")
        data["view"] = HostView(**view) if kind == "host" else WorkspaceView(**view)
        for name, factory in (("limits", Limits), ("lifetime", Lifetime), ("retention", Retention)):
            data[name] = factory(**data.get(name, {}))
        return cls(**data)


@dataclasses.dataclass(frozen=True)
class Plan:
    """Resolved request and its concrete paths, capabilities and assumptions."""

    spec: EnvironmentSpec
    root: Path
    storage_roots: dict[str, Path]
    trees: dict[str, dict]
    mounts: tuple[dict, ...]
    warnings: tuple[str, ...] = ()
    errors: tuple[str, ...] = ()
    backend: str = "linux-systemd"

    @property
    def supported(self) -> bool:
        """Whether all static prerequisites of the plan are satisfied."""
        return not self.errors

    def to_dict(self) -> dict:
        """Return a diagnostic plan without allocating any resource."""
        result = json_value(self)
        result["spec"] = self.spec.to_dict()
        result["supported"] = self.supported
        return result


@dataclasses.dataclass(frozen=True)
class CommandResult:
    """Direct-command observation, separate from environment or tree completion."""

    command_id: str
    returncode: int | None
    exit_observed: bool
    stdout_path: str | None = None
    stderr_path: str | None = None

    @property
    def signal(self) -> int | None:
        """Observed terminating signal, without inferring its initiating cause."""
        return -self.returncode if self.returncode is not None and self.returncode < 0 else None

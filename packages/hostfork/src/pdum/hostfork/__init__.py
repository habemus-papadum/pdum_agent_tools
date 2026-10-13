"""Host-derived environments with explicit lifetime and retained evidence."""

from .environment import Command, Environment, Hostfork
from .errors import EnvironmentClosed, HostforkError, OwnershipConflict, UnsupportedCapability
from .models import (
    CommandResult,
    EnvironmentSpec,
    HostView,
    Lifetime,
    Limits,
    Plan,
    PrivateTree,
    Retention,
    WorkspaceView,
)

__all__ = [
    "Command",
    "CommandResult",
    "Environment",
    "EnvironmentClosed",
    "EnvironmentSpec",
    "HostView",
    "Hostfork",
    "HostforkError",
    "Lifetime",
    "Limits",
    "OwnershipConflict",
    "Plan",
    "PrivateTree",
    "Retention",
    "UnsupportedCapability",
    "WorkspaceView",
]

"""Isolated Claude profiles and foreground workers for official SDK clients."""

from .authentication import AuthSpec, AuthStatus, auth_status, build_environment, login_auth
from .errors import AuthenticationError, LauncherError, ProfileError
from .observation import JsonlRecorder, Observation, ObservationHub, Processor, UsageObserver
from .profiles import (
    Profile,
    create_profile,
    default_profiles_directory,
    list_profiles,
    load_profile,
    resolve_profile,
    temporary_profile,
)
from .relay import open_relay
from .runtime import ClaudeManager, LaunchOptions, Worker
from .storage import History, HistoryError

__all__ = [
    "AuthSpec",
    "AuthStatus",
    "AuthenticationError",
    "ClaudeManager",
    "History",
    "HistoryError",
    "JsonlRecorder",
    "LaunchOptions",
    "LauncherError",
    "Observation",
    "ObservationHub",
    "Processor",
    "Profile",
    "ProfileError",
    "UsageObserver",
    "Worker",
    "auth_status",
    "build_environment",
    "create_profile",
    "default_profiles_directory",
    "list_profiles",
    "load_profile",
    "login_auth",
    "open_relay",
    "resolve_profile",
    "temporary_profile",
]

"""Actionable Claude launcher failures without credential payloads."""


class LauncherError(Exception):
    """Base class for expected Claude launcher errors."""


class ProfileError(LauncherError):
    """A profile is missing, malformed, or conflicts with another path."""


class AuthenticationError(LauncherError):
    """The selected host authentication method is unavailable or failed."""


class LaunchError(LauncherError):
    """An owned Claude worker could not start or complete a lifecycle operation."""


class StorageError(LauncherError):
    """An official SDK history operation failed."""

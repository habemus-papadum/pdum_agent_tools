"""Actionable launcher failures."""


class LauncherError(Exception):
    """Base class for expected configuration and lifecycle errors."""


class ProfileError(LauncherError):
    """A profile is missing, malformed, or conflicts with an existing path."""


class ProfileBusy(LauncherError):
    """Another process still owns the profile lease."""


class OwnershipUncertain(LauncherError):
    """Recorded ownership cannot be safely reconciled with a live process."""


class LaunchError(LauncherError):
    """The selected executable did not become a ready app-server."""

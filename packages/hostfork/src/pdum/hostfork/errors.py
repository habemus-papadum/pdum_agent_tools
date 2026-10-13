"""Actionable errors at the public Hostfork boundary."""


class HostforkError(RuntimeError):
    """An environment operation failed with recoverable diagnostic context."""


class UnsupportedCapability(HostforkError):
    """The selected backend cannot supply a requested guarantee."""


class OwnershipConflict(HostforkError):
    """A path or resource no longer has its recorded owner/identity."""


class EnvironmentClosed(HostforkError):
    """The environment no longer admits commands."""

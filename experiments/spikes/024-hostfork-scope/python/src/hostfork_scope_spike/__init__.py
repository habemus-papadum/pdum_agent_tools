"""Experimental Python-owned process adoption; importing starts nothing."""

from .scoped_process import ScopedProcess, launch_scoped

__all__ = ["ScopedProcess", "launch_scoped"]

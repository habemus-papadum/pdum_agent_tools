"""Owned private trees, independent of workload and registry ownership.

The caller reserves and journals an allocation directory before calling this
module. Operations never remove that directory or borrowed inputs. Release and
overlay export require the caller to fence writers and namespace users first.
"""

from ._trees import (
    StorageError,
    TreeRecord,
    allocate,
    confirm_reclamation,
    export_tree,
    inspect,
    recover_export,
    recover_record,
    release,
    usage,
    validate_source,
)

__all__ = [
    "StorageError",
    "TreeRecord",
    "allocate",
    "confirm_reclamation",
    "export_tree",
    "inspect",
    "recover_export",
    "recover_record",
    "release",
    "usage",
    "validate_source",
]

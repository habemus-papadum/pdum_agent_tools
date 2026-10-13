"""Resolve a request without allocating private trees or launching helpers."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

from .models import EnvironmentSpec, HostView, Plan, WorkspaceView
from .store import Store, path_identity

NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def absolute(path: str | Path) -> Path:
    """Require explicit absolute paths at the presentation boundary."""
    value = Path(path).expanduser()
    if not value.is_absolute():
        raise ValueError(f"An absolute path is required: {value}")
    return value


async def make_plan(spec: EnvironmentSpec, store: Store, pools: dict[str, Path]) -> Plan:
    """Resolve baseline references, path sharing and backend prerequisites."""
    from . import storage

    errors: list[str] = []
    warnings: list[str] = ["Unchanged host paths and networking remain shared; this is not a security boundary."]
    if sys.platform != "linux":
        errors.append("Execution currently requires the Linux backend; native macOS execution is not implemented.")
    trees: dict[str, dict] = {}
    roots = {
        "default": store.root / "trees",
        **{key: Path(value).expanduser().resolve() for key, value in pools.items()},
    }
    for name, tree in spec.trees.items():
        if not NAME.fullmatch(name):
            raise ValueError(f"Invalid tree name: {name!r}")
        if tree.pool not in roots:
            raise ValueError(f"Unknown storage pool: {tree.pool}")
        baseline = store.baseline(tree.baseline) if tree.baseline else None
        source = Path(baseline["path"]) if baseline else (absolute(tree.source).resolve() if tree.source else None)
        stable = tree.stable or bool(baseline and baseline.get("stable"))
        if baseline and baseline["identity"] != path_identity(source):
            raise ValueError(f"Baseline path identity changed: {tree.baseline}")
        if source is not None:
            if not source.is_dir():
                raise ValueError(f"Tree source must be an existing directory: {source}")
            for managed in (store.root, *roots.values()):
                if managed.is_relative_to(source):
                    raise ValueError(
                        f"Source would recursively include Hostfork state/storage: {source} contains {managed}"
                    )
        kind = "copy" if tree.storage == "empty" else tree.storage
        if tree.storage != "empty":
            try:
                await storage.validate_source(kind, source, stable=stable)
            except (OSError, RuntimeError, ValueError) as error:
                errors.append(f"Tree {name}: {error}")
        trees[name] = {
            "kind": kind,
            "source": str(source) if source else None,
            "pool": tree.pool,
            "stable": stable,
            "baseline": tree.baseline,
            "baseline_record": baseline,
            "source_identity": path_identity(source) if source else None,
        }
        if kind == "overlay":
            warnings.append(f"Tree {name} needs its lower source stable and available through retained-view export.")
        elif kind == "copy" and source:
            warnings.append(f"Tree {name} is a directory walk, not an atomic application snapshot.")

    mounts: list[dict] = []
    if isinstance(spec.view, WorkspaceView):
        if spec.view.tree not in trees:
            raise ValueError(f"Workspace names unknown tree: {spec.view.tree}")
        if trees[spec.view.tree]["kind"] == "overlay":
            raise ValueError("WorkspaceView needs a directly readable copy or snapshot, not an unmounted overlay")
    elif isinstance(spec.view, HostView):
        targets: set[Path] = set()
        assigned: set[str] = set()

        def target(value: str) -> str:
            path = absolute(value)
            actual = path.resolve()
            if not path.exists() or path.is_symlink() or actual == Path("/"):
                raise ValueError(f"Mount target must exist, be nonsymlink and not filesystem root: {path}")
            if actual in targets:
                raise ValueError(f"Duplicate/aliased mount target: {path}")
            if any(managed.is_relative_to(actual) for managed in (store.root, *roots.values())):
                raise ValueError(f"Mount would hide Hostfork state or storage; choose an outside root: {path}")
            targets.add(actual)
            return str(actual)

        for visible, name in spec.view.replace.items():
            if name not in trees:
                raise ValueError(f"Mount references unknown tree: {name}")
            if name in assigned:
                raise ValueError(f"Each named tree has one primary presentation path: {name}")
            assigned.add(name)
            destination = target(visible)
            if not Path(destination).is_dir():
                raise ValueError(f"Private tree presentation requires a directory: {destination}")
            mounts.append({"kind": "tree", "tree": name, "target": destination})
        for visible in spec.view.read_only:
            destination = target(visible)
            mounts.append({"kind": "read_only", "source": destination, "target": destination})
        for visible, source in spec.view.shared.items():
            destination = target(visible)
            source_path = absolute(source).resolve()
            if not source_path.exists():
                raise ValueError(f"Shared source is unavailable: {source_path}")
            mounts.append({"kind": "bind", "source": str(source_path), "target": destination})
        for visible in spec.view.fresh:
            destination = target(visible)
            if not Path(destination).is_dir():
                raise ValueError(f"Fresh presentation requires a directory: {destination}")
            mounts.append({"kind": "fresh", "target": destination})
        for name, tree in trees.items():
            if tree["kind"] == "overlay" and name not in assigned:
                raise ValueError(f"Overlay {name} needs a HostView presentation target")
    else:
        raise ValueError("Unknown view implementation")
    mounts.sort(key=lambda item: (len(Path(item["target"]).parts), item["target"]))
    if spec.lifetime.max_runtime is None:
        warnings.append("No execution deadline is requested; unattended recovery depends on configured host support.")
    if os.name == "posix" and hasattr(os, "getgroups") and len(os.getgroups()) > 1:
        warnings.append(
            "User-namespace identity mapping may not preserve supplementary-group access; doctor can probe it."
        )
    return Plan(spec, store.root, roots, trees, tuple(mounts), tuple(warnings), tuple(errors))

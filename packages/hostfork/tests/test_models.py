"""Public request validation and serialization without a runtime."""

from datetime import timedelta

import pytest
from pdum.hostfork import EnvironmentSpec, HostView, Lifetime, Limits, PrivateTree, Retention, WorkspaceView
from pdum.hostfork.models import CommandResult, seconds


@pytest.mark.parametrize("value", [-1, float("nan"), float("inf")])
def test_invalid_duration(value):
    with pytest.raises(ValueError):
        seconds(value)


@pytest.mark.parametrize(
    "kwargs", [{"memory_bytes": 0}, {"memory_bytes": True}, {"cpu_cores": -1}, {"cpu_cores": float("nan")}]
)
def test_invalid_limits(kwargs):
    with pytest.raises(ValueError):
        Limits(**kwargs)


@pytest.mark.parametrize(
    "kwargs",
    [{"max_runtime": 0}, {"max_runtime": 1, "grace_seconds": 2}, {"owner_exit": "abandon"}, {"setup_timeout": 0}],
)
def test_invalid_lifetime(kwargs):
    with pytest.raises(ValueError):
        Lifetime(**kwargs)


def test_roundtrip():
    spec = EnvironmentSpec(
        trees={"work": PrivateTree(source="/work", storage="overlay", stable=True)},
        view=HostView(replace={"/work": "work"}),
        lifetime=Lifetime(timedelta(minutes=20)),
        retention=Retention(trees=60, evidence=120),
        labels={"experiment": "x"},
    )
    restored = EnvironmentSpec.from_dict(spec.to_dict())
    assert restored.to_dict() == spec.to_dict()
    assert restored.lifetime.max_runtime == 1200
    assert EnvironmentSpec.from_dict(EnvironmentSpec(view=WorkspaceView("tree")).to_dict()).view.tree == "tree"


def test_no_unknown_schema_or_inferred_signal_cause():
    with pytest.raises(TypeError):
        EnvironmentSpec.from_dict({"unknown": 1})
    with pytest.raises(ValueError):
        EnvironmentSpec.from_dict({"view": {"kind": "docker"}})
    assert CommandResult("id", -9, True).signal == 9
    assert CommandResult("id", None, False).signal is None

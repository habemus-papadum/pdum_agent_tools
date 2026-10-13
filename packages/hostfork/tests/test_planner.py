"""Plan invariants protect host sources and keep unsupported features explicit."""

import sys

import pytest
from pdum.hostfork import EnvironmentSpec, Hostfork, HostView, PrivateTree, WorkspaceView


@pytest.mark.asyncio
async def test_plan_no_mutation_and_source_overlap(tmp_path):
    host = Hostfork(tmp_path / "state")
    source = tmp_path / "source"
    source.mkdir()
    spec = EnvironmentSpec(trees={"a": PrivateTree(source)}, view=HostView(replace={str(source): "a"}))
    plan = await host.plan(spec)
    assert plan.trees["a"]["kind"] == "copy"
    assert plan.mounts[0]["tree"] == "a"
    assert not host.store.root.exists()
    with pytest.raises(ValueError, match="recursively"):
        await host.plan(EnvironmentSpec(trees={"bad": PrivateTree(tmp_path)}))


@pytest.mark.asyncio
async def test_invalid_targets_and_unstable_overlay(tmp_path):
    host = Hostfork(tmp_path / "state")
    source = tmp_path / "source"
    source.mkdir()
    with pytest.raises(ValueError, match="hide"):
        await host.plan(EnvironmentSpec(view=HostView(read_only=(str(tmp_path),))))
    with pytest.raises(ValueError, match="Duplicate"):
        await host.plan(EnvironmentSpec(view=HostView(read_only=(str(source), str(source)))))
    with pytest.raises(ValueError, match="unknown tree"):
        await host.plan(EnvironmentSpec(view=HostView(replace={str(source): "missing"})))
    plan = await host.plan(
        EnvironmentSpec(trees={"x": PrivateTree(source, storage="overlay")}, view=HostView(replace={str(source): "x"}))
    )
    assert not plan.supported
    with pytest.raises(ValueError, match="unmounted overlay"):
        await host.plan(
            EnvironmentSpec(trees={"x": PrivateTree(source, storage="overlay", stable=True)}, view=WorkspaceView("x"))
        )


@pytest.mark.asyncio
@pytest.mark.skipif(sys.platform != "linux", reason="Baseline validation uses the implemented Linux storage backend")
async def test_registered_baseline_and_empty_workspace(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    host = Hostfork(tmp_path / "state")
    await host.register_baseline("base", source)
    plan = await host.plan(EnvironmentSpec(trees={"x": PrivateTree(baseline="base")}))
    assert plan.trees["x"]["stable"]
    assert (await host.plan(EnvironmentSpec(trees={"x": PrivateTree(storage="empty")}, view=WorkspaceView("x")))).trees[
        "x"
    ]["source"] is None

import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("accounting", Path(__file__).with_name("analysis.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def event(method, params, direction="server", **extra):
    return {"direction": direction, "message": {"method": method, "params": params, **extra}}


def usage(total, last=0):
    return event(
        "thread/tokenUsage/updated",
        {"threadId": "t", "tokenUsage": {"total": dict(zip(module.FIELDS, total)), "last": {"totalTokens": last}}},
    )


def born():
    a = module.Analysis()
    a.accept(event("thread/start", {}, "client", id=1))
    a.accept({"direction": "server", "message": {"id": 1, "result": {"thread": {"id": "t"}, "model": "gpt-6-luna"}}})
    return a


def test_cache_writes_replace_uncached_input_and_reasoning_is_not_extra():
    counts = dict(zip(module.FIELDS, (1000, 500, 200, 100)))
    counts["reasoningOutputTokens"] = 90
    assert module.price(counts, "gpt-6-luna") == "0.00011"
    assert module.price(dict(zip(module.FIELDS, (100, 80, 50, 0))), "gpt-6-luna") is None


def test_missing_counts_and_unknown_model_are_not_free():
    assert module.price({"inputTokens": 1000}, "gpt-6-luna") is None
    assert module.price(dict(zip(module.FIELDS, (0, 0, 0, 0))), "unknown") is None


def test_duplicate_multiclient_snapshots_and_local_context_change_are_not_new_spend():
    a = born()
    a.accept(usage((1000, 500, 0, 100), 1100))
    a.accept({**usage((1000, 500, 0, 100), 1200), "connection": "B"})
    a.accept(usage((2000, 1000, 0, 200), 1100))
    assert a.snapshot()["threads"]["t"]["estimatedUsd"] == "0.000210"
    assert a.snapshot()["threads"]["t"]["pricedIncrements"] == 2


def test_late_join_and_fork_do_not_charge_inherited_prefix():
    a = module.Analysis()
    a.accept(usage((1000, 500, 0, 100)))
    assert a.snapshot()["threads"]["t"]["estimatedUsd"] == "0"
    assert a.snapshot()["threads"]["t"]["issues"]
    a.accept(usage((2000, 1000, 0, 200)))
    assert a.snapshot()["threads"]["t"]["unpricedIncrements"] == 1


def test_counter_drop_stays_explicitly_uncertain():
    a = born()
    a.accept(usage((1000, 500, 0, 100)))
    a.accept(usage((500, 200, 0, 50)))
    assert "counter decrease" in a.snapshot()["threads"]["t"]["issues"][0]
    assert a.snapshot()["threads"]["t"]["observedCounts"]["inputTokens"] == 1000

"""Regression checks against real DuckDB files in the production history schema."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb
import pytest
from pdum.agent_history import schema

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "evals" / "bin"))
import report  # noqa: E402


def measure(tmp_path, monkeypatch, rows, **manifest_options):
    monkeypatch.setenv("EVALS_HOME", str(tmp_path))
    directory = tmp_path / "test"
    directory.mkdir(exist_ok=True)
    con = duckdb.connect(str(directory / "history.duckdb"))
    schema.create(con)
    for table, records in rows.items():
        schema.insert(con, table, [schema.row(table, **values) for values in records])
    con.close()
    manifest = {"run_id": "test", "task": "hp-mini", "label": "test", "agent": "fixture", **manifest_options}
    return report.measure(manifest)


def response(thread="root", response_id="r", **overrides):
    return {
        "thread_id": thread,
        "response_id": response_id,
        "model": "gpt-6-luna",
        "input_tokens": 1000,
        "cached_input_tokens": 0,
        "cache_write_input_tokens": 0,
        "output_tokens": 100,
        "origin": "runtime",
        "rollout_ordinal": 1,
        **overrides,
    }


@pytest.mark.parametrize("child_calls", [1, 3])
def test_root_selection_does_not_pick_more_active_or_tied_child(tmp_path, monkeypatch, child_calls):
    result = measure(
        tmp_path,
        monkeypatch,
        {
            "threads": [{"thread_id": "root"}, {"thread_id": "aaa-child", "parent_thread_id": "root"}],
            "responses": [response()] + [response("aaa-child", f"child-{i}") for i in range(child_calls)],
        },
    )
    assert result["main_thread"] == "root"
    assert result["root_selection"] == "single-lineage-root"
    assert result["steps"] == 1
    assert result["responses_total"] == 1 + child_calls


def test_lineage_edges_exclude_child_and_fork_when_thread_columns_are_missing(tmp_path, monkeypatch):
    result = measure(
        tmp_path,
        monkeypatch,
        {
            "threads": [{"thread_id": name} for name in ["root", "child", "fork"]],
            "spawn_edges": [{"parent_thread_id": "root", "child_thread_id": "child"}],
            "fork_edges": [{"parent_thread_id": "root", "child_thread_id": "fork"}],
            "responses": [response(), response("fork", "fork-r")],
        },
    )
    assert result["main_thread"] == "root"


def test_multiple_roots_require_explicit_selection(tmp_path, monkeypatch):
    with pytest.raises(ValueError, match="Several lineage roots"):
        measure(tmp_path, monkeypatch, {"threads": [{"thread_id": "a"}, {"thread_id": "b"}]})
    selected = report.measure(
        {"run_id": "test", "task": "hp-mini", "label": "test", "agent": "fixture", "root_thread_id": "b"}
    )
    assert selected["main_thread"] == "b"


def test_forked_tool_bytes_are_excluded_and_node_test_command_is_recognized(tmp_path, monkeypatch):
    result = measure(
        tmp_path,
        monkeypatch,
        {
            "threads": [{"thread_id": "root"}],
            "responses": [response()],
            "items": [
                {
                    "thread_id": "root",
                    "item_type": "toolCall",
                    "output_bytes": 80,
                    "origin": "runtime",
                    "command": '{"cmd":"node --test test/usage.test.mjs"}',
                },
                {"thread_id": "fork", "item_type": "toolCall", "output_bytes": 80, "origin": "copied-context"},
                {"thread_id": "root", "item_type": "agentMessage", "output_bytes": 10000, "origin": "runtime"},
            ],
        },
    )
    assert result["tool_calls"] == 1
    assert result["tool_bytes"] == 80
    assert result["ran_tests"] is True


def test_each_response_uses_its_model_price_and_preserves_subcent_precision(tmp_path, monkeypatch):
    result = measure(
        tmp_path,
        monkeypatch,
        {
            "threads": [{"thread_id": "root"}],
            "responses": [
                response(cached_input_tokens=400, cache_write_input_tokens=100, output_tokens=50),
                response(response_id="astra", model="gpt-6-astra"),
                response(response_id="copied", model="gpt-6-astra", origin="copied-context"),
            ],
        },
    )
    # Luna: (500*.10 + 400*.01 + 100*.125 + 50*.50)/1e6; Astra: (1000*10 + 100*50)/1e6.
    assert result["cost_usd_list"] == pytest.approx(0.0150915)
    assert result["pricing_version"] == "2026-10-18-standard-v2"
    assert result["cost_status"] == "complete-recorded-usage"


def test_luna_long_context_rates_apply_to_whole_request(tmp_path, monkeypatch):
    result = measure(
        tmp_path,
        monkeypatch,
        {
            "threads": [{"thread_id": "root"}],
            "responses": [
                response(
                    input_tokens=300000, cached_input_tokens=100000, cache_write_input_tokens=10000, output_tokens=1000
                )
            ],
        },
    )
    assert result["cost_usd_list"] == pytest.approx(0.04325)


@pytest.mark.parametrize(
    "overrides",
    [{"model": "unpriced-model"}, {"input_tokens": None}, {"cached_input_tokens": None}, {"output_tokens": None}],
)
def test_missing_usage_or_price_is_unknown_not_zero(tmp_path, monkeypatch, overrides):
    result = measure(
        tmp_path,
        monkeypatch,
        {
            "threads": [{"thread_id": "root"}],
            "responses": [response(), response(response_id="unknown", **overrides)],
        },
    )
    assert result["cost_usd_list"] is None
    assert result["cost_usd"] is None
    assert result["cost_usd_priced_subset"] > 0
    assert len(result["unpriced_responses"]) == 1
    if overrides.get("output_tokens", 0) is None:
        assert result["output_tokens"] is None
        assert result["usage_gaps"]["output"] == 1


def test_no_recorded_usage_does_not_claim_zero_cost(tmp_path, monkeypatch):
    result = measure(tmp_path, monkeypatch, {"threads": [{"thread_id": "root"}]})
    assert result["steps"] == 0
    assert result["output_tokens"] is None
    assert result["cost_usd"] is None
    assert result["cost_status"] == "no-recorded-usage"


def test_explicit_zero_provider_ledger_does_not_fall_back_to_list_estimate(tmp_path, monkeypatch):
    (tmp_path / "test").mkdir()
    (tmp_path / "test" / "result.json").write_text(json.dumps({"total_cost_usd": 0}))
    result = measure(tmp_path, monkeypatch, {"threads": [{"thread_id": "root"}], "responses": [response()]})
    assert result["cost_usd_list"] > 0
    assert result["cost_usd"] == 0
    assert result["cost_basis"] == "provider-reported-ledger"


def test_legacy_baseline_is_not_silently_repriced_or_compared(tmp_path):
    baseline = {"runs": [{"cost_usd": 7.8}], "envelope": {"cost_usd": [3.3, 7.8]}}
    before = json.dumps(baseline)
    flags = report.flags_for(
        {"pricing_version": report.PRICING_VERSION, "cost_status": "complete-recorded-usage", "cost_usd": 0.001},
        {},
        {},
        baseline,
    )
    assert any("pricing version differs" in flag for flag in flags)
    assert not any("cost_usd =" in flag for flag in flags)
    assert json.dumps(baseline) == before

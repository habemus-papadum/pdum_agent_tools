"""Clock-scope regressions and opt-in checks against an actual native family."""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from collect_codex_family import activity_references, native_items, timing_report
from export_history import assert_history_only


class TestClockMeaning(unittest.TestCase):
    def test_unknown_zero_and_different_duration_scopes_remain_distinct(self):
        # Synthetic numeric edge cases establish our comparison semantics, not
        # upstream behavior. Captured-native checks below qualify real pages.
        items = [
            {"id": "zero", "type": "commandExecution", "durationMs": 0},
            {"id": "unknown-start", "type": "commandExecution", "durationMs": 0},
            {"id": "other-scope", "type": "commandExecution", "durationMs": 12},
        ]
        thread = {"turns": [{"id": "turn", "items": items, "startedAt": 0, "completedAt": None}]}
        pages = [
            {
                "result": {
                    "data": [
                        {"turnId": "turn", "item": items[0], "startedAtMs": 0, "completedAtMs": 0},
                        {"turnId": "turn", "item": items[1], "startedAtMs": None, "completedAtMs": 5},
                        {"turnId": "turn", "item": items[2], "startedAtMs": 100, "completedAtMs": 400},
                    ]
                }
            }
        ]
        result = timing_report(thread, pages)
        zero, unknown, other = result["measurements"]
        self.assertEqual(zero["endpointIntervalMs"], 0)
        self.assertIsNone(unknown["endpointIntervalMs"])
        self.assertIsNone(unknown["intervalMinusReportedMs"])
        self.assertEqual(other["endpointIntervalMs"], 300)
        self.assertEqual(other["reportedDurationMs"], 12)
        self.assertEqual(other["intervalMinusReportedMs"], 288)
        self.assertEqual(result["turnClocks"][0]["startedAtUnixSeconds"], 0)
        self.assertIsNone(result["turnClocks"][0]["completedAtUnixSeconds"])


@unittest.skipUnless(
    os.environ.get("PDUM_CODEX_FAMILY_EXPORT_DIR"), "Set PDUM_CODEX_FAMILY_EXPORT_DIR to native evidence"
)
class TestNativeCodexFamily(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = Path(os.environ["PDUM_CODEX_FAMILY_EXPORT_DIR"])
        cls.evidence = json.loads((cls.directory / "evidence.json").read_text())
        cls.family = json.loads((cls.directory / "family.json").read_text())
        cls.documents = [json.loads(path.read_text()) for path in (cls.directory / "documents").glob("*.json")]

    def test_source_hygiene_and_no_runtime_activation(self):
        evidence = self.evidence
        self.assertEqual(evidence["sourceHashesBefore"], evidence["sourceHashesAfter"])
        self.assertTrue(evidence["sourceHistoryUnchanged"])
        self.assertTrue(evidence["ownedProcessReaped"])
        self.assertEqual(evidence["loadedBefore"]["data"], [])
        self.assertEqual(evidence["loadedAfter"]["data"], [])
        self.assertEqual(evidence["inference"]["submittedTurns"], 0)
        for method in evidence["methods"]:
            assert_history_only(method)
        self.assertFalse(
            any(message.get("method", "").startswith(("turn/", "item/")) for message in evidence["notifications"])
        )

    def test_selected_family_closes_all_native_references(self):
        identities = {doc["sessionId"] for doc in self.documents}
        self.assertGreater(len(identities), 1)
        self.assertEqual(self.family["unresolvedReferences"], {})
        for doc in self.documents:
            thread = doc["payload"]["thread"]
            self.assertTrue(activity_references(thread) <= identities)
            if doc["sessionId"] != self.family["parentThreadId"]:
                self.assertIn(thread["parentThreadId"], identities)

    def test_full_native_pages_preserve_payload_and_report_missing_clocks(self):
        for doc in self.documents:
            thread, pages = doc["payload"]["thread"], doc["payload"]["itemPages"]
            records = [record for page in pages for record in page["result"]["data"]]
            self.assertEqual([(record["turnId"], record["item"]) for record in records], native_items(thread))
            report = timing_report(thread, pages)
            self.assertEqual(report["missingFromPages"], 0)
            self.assertEqual(report["notInFullRead"], 0)
            for record, measured in zip(records, report["measurements"], strict=True):
                self.assertEqual(measured["startedAtMs"], record.get("startedAtMs"))
                self.assertEqual(measured["completedAtMs"], record.get("completedAtMs"))

    def test_repeated_completion_events_reference_child_work_turns(self):
        outcomes = self.family["completionOutcomeReferences"]
        self.assertTrue(outcomes)
        self.assertTrue(all(outcome["matchesTargetTurn"] for outcome in outcomes))
        self.assertGreater(len(outcomes), len({outcome["agentThreadId"] for outcome in outcomes}))


if __name__ == "__main__":
    unittest.main()

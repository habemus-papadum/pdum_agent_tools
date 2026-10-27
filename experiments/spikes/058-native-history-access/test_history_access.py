"""Negative guard checks and validation of separately captured native exports."""

import hashlib
import importlib.util
import json
import os
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("history_export", Path(__file__).with_name("export_history.py"))
assert SPEC and SPEC.loader
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


class TestReadBoundary(unittest.TestCase):
    def test_lifecycle_and_execution_methods_are_rejected(self):
        for method in (
            "thread/resume",
            "thread/start",
            "turn/start",
            "thread/fork",
            "thread/archive",
            "thread/shellCommand",
            "thread/queue/add",
            "account/login/start",
            "process/spawn",
        ):
            with self.subTest(method=method), self.assertRaises(ValueError):
                exporter.assert_history_only(method)


@unittest.skipUnless(os.environ.get("PDUM_HISTORY_EXPORT_DIR"), "Set PDUM_HISTORY_EXPORT_DIR to a real local export")
class TestNativeExport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = Path(os.environ["PDUM_HISTORY_EXPORT_DIR"])
        cls.catalog = json.loads((cls.directory / "catalog.json").read_text())
        cls.evidence = json.loads((cls.directory / "evidence.json").read_text())
        cls.documents = [
            json.loads((cls.directory / "documents" / f"{row['key']}.json").read_text())
            for row in cls.catalog["sessions"]
        ]

    def test_native_inspection_never_loaded_or_changed_sessions(self):
        codex, claude = self.evidence["codex"], self.evidence["claude"]
        self.assertEqual(codex["loadedBefore"]["data"], [])
        self.assertEqual(codex["loadedAfter"]["data"], [])
        self.assertEqual(set(codex["listedBefore"]), set(codex["listedAfter"]))
        self.assertTrue(codex["sourceHistoryUnchanged"])
        self.assertTrue(codex["ownedProcessReaped"])
        self.assertTrue(claude["nativeHistoryUnchanged"])
        self.assertTrue(claude["sourceHistoryUnchanged"])
        self.assertTrue(claude["helperClosed"])
        self.assertEqual(claude["listedBefore"], claude["listedAfter"])
        self.assertEqual(self.evidence["inference"]["submittedTurns"], 0)
        for method in codex["methods"]:
            exporter.assert_history_only(method)

    def test_both_native_payloads_preserve_real_tool_results(self):
        codex = [doc for doc in self.documents if doc["provider"] == "codex"]
        claude = [doc for doc in self.documents if doc["provider"] == "claude"]
        self.assertTrue(codex and claude)
        commands = [
            item
            for doc in codex
            for turn in doc["payload"]["thread"]["turns"]
            for item in turn["items"]
            if item["type"] == "commandExecution"
        ]
        self.assertTrue(any(item.get("aggregatedOutput") and "exitCode" in item for item in commands))
        blocks = [
            block
            for doc in claude
            for message in doc["payload"]["messages"]
            for block in message["message"].get("content", [])
            if isinstance(block, dict)
        ]
        calls = {block["id"] for block in blocks if block.get("type") == "tool_use"}
        results = {block["tool_use_id"] for block in blocks if block.get("type") == "tool_result"}
        self.assertTrue(calls & results, "Export should include at least one real paired Claude tool result")

    def test_identity_and_native_pages_are_consistent(self):
        self.assertEqual(self.catalog["version"], 1)
        self.assertEqual(len({row["key"] for row in self.catalog["sessions"]}), len(self.documents))
        for row, doc in zip(self.catalog["sessions"], self.documents, strict=True):
            self.assertNotIn("payload", row)
            self.assertEqual(row, {key: value for key, value in doc.items() if key != "payload"})
            if doc["provider"] == "codex":
                self.assertEqual(doc["sessionId"], doc["payload"]["thread"]["id"])
                if doc["source"]["coverage"].get("historyMode") == "paginated" and "itemPages" in doc["payload"]:
                    paged = [
                        entry["item"]
                        for page in doc["payload"]["itemPages"]
                        for entry in page.get("result", {}).get("data", [])
                    ]
                    full = [item for turn in doc["payload"]["thread"]["turns"] for item in turn["items"]]
                    self.assertEqual(paged, full)
            else:
                self.assertEqual(doc["sessionId"], doc["payload"]["info"]["session_id"])

    def test_everyday_corpus_contains_long_native_records_and_rich_content(self):
        everyday = [doc for doc in self.documents if doc["source"].get("corpus") == "everyday"]
        if not everyday:
            self.skipTest("Run the explicit everyday-corpus extension first")
        for provider in ("codex", "claude"):
            self.assertTrue(
                any(doc["provider"] == provider and doc["source"]["summary"]["items"] > 400 for doc in everyday)
            )
        features = {feature for doc in everyday for feature in doc["source"]["summary"]["features"]}
        self.assertTrue({"math-in-prose", "mermaid", "image:user", "image:tool-result", "embedded-images"} <= features)
        phases = {phase for doc in everyday for phase in doc["source"]["summary"]["phases"]}
        self.assertTrue({"commentary", "final_answer"} <= phases)

    def test_copied_asset_bytes_have_separate_retrieval_qualification(self):
        assets = [
            asset
            for doc in self.documents
            for asset in doc["source"].get("assets", [])
            if asset["kind"] == "copied-at-export"
        ]
        if not assets:
            self.skipTest("No copied image assets in this selected export")
        for asset in assets:
            path = self.directory / asset["path"]
            self.assertEqual(path.parent, self.directory / "assets")
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), asset["sha256"])
            self.assertEqual(path.stat().st_size, asset["bytes"])
            self.assertIn("unverified", asset["qualification"])

    def test_math_qualification_points_to_actual_assistant_prose(self):
        qualified = [doc for doc in self.documents if doc["source"].get("summary", {}).get("mathProseItemIndexes")]
        if not qualified:
            self.skipTest("No separately qualified mathematical-prose capture")
        for doc in qualified:
            items = [item for turn in doc["payload"]["thread"]["turns"] for item in turn["items"]]
            for index in doc["source"]["summary"]["mathProseItemIndexes"]:
                item = items[index]
                self.assertEqual(item["type"], "agentMessage")
                self.assertIn(item["phase"], ("commentary", "final_answer"))
                self.assertNotIn("[external_agent_", item["text"])
                self.assertTrue("\\[" in item["text"] or "\\(" in item["text"])


if __name__ == "__main__":
    unittest.main()

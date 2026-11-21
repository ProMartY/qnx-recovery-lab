"""Reject evidence drift before producing a shareable successful report."""

import hashlib
import json
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from export_report import export


class ExportEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        artifacts = Path(__file__).resolve().parents[1] / "artifacts"
        self.data = json.loads((artifacts / "latest.json").read_text(encoding="utf-8-sig"))
        evidence = self.data["evidence"]
        self.console = self.folder / evidence["console"]
        self.console.write_bytes((artifacts / evidence["console"]).read_bytes())
        self.data["evidence"]["console_sha256"] = hashlib.sha256(self.console.read_bytes()).hexdigest()
        if "source_snapshot" in evidence:
            self.source = self.folder / evidence["source_snapshot"]
            self.source.write_bytes((artifacts / evidence["source_snapshot"]).read_bytes())
        self.trace = self.folder / "recording.json"
        self.save_trace()

    def save_trace(self):
        self.trace.write_text(json.dumps(self.data), encoding="utf-8")

    def test_successful_exports_keep_containment_as_a_pass(self):
        paths = export(self.trace)
        suite = ET.parse(paths[1]).getroot()
        self.assertEqual(int(suite.get("tests")), len(self.data["scenarios"]))
        self.assertEqual(suite.get("failures"), "0")
        self.assertIn("contained", paths[0].read_text(encoding="utf-8"))
        manifest = json.loads(paths[2].read_text(encoding="utf-8"))
        self.assertEqual(manifest["trace"]["sha256"], hashlib.sha256(self.trace.read_bytes()).hexdigest())

    def test_console_digest_drift_is_rejected_before_exports(self):
        self.console.write_bytes(self.console.read_bytes() + b"unexpected extra console output\n")
        with self.assertRaisesRegex(ValueError, "console SHA-256 mismatch"):
            export(self.trace)
        self.assertFalse(self.trace.with_suffix(".md").exists())

    def test_modified_guest_event_is_rejected_even_with_recomputed_digest(self):
        lines = self.console.read_text(encoding="utf-8-sig").splitlines()
        for index, line in enumerate(lines):
            if line.startswith("RECOVERY_EVENT "):
                event = json.loads(line[len("RECOVERY_EVENT "):])
                event["reason"] = "changed outside the recorded trace"
                lines[index] = "RECOVERY_EVENT " + json.dumps(event)
                break
        self.console.write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.data["evidence"]["console_sha256"] = hashlib.sha256(self.console.read_bytes()).hexdigest()
        self.save_trace()
        with self.assertRaisesRegex(ValueError, "events differ"):
            export(self.trace)

    def test_unsuccessful_guest_exit_is_rejected(self):
        raw = self.console.read_text(encoding="utf-8-sig").replace("RECOVERY_RUN_EXIT=0", "RECOVERY_RUN_EXIT=1")
        self.console.write_text(raw, encoding="utf-8")
        self.data["evidence"]["console_sha256"] = hashlib.sha256(self.console.read_bytes()).hexdigest()
        self.save_trace()
        with self.assertRaisesRegex(ValueError, "unsuccessful guest exit"):
            export(self.trace)

    def test_raw_boolean_cannot_be_replaced_with_numeric_success(self):
        lines = self.console.read_text(encoding="utf-8-sig").splitlines()
        for index, line in enumerate(lines):
            if line.startswith("RECOVERY_EVENT "):
                event = json.loads(line[len("RECOVERY_EVENT "):])
                if event["event"] == "summary":
                    event["passed"] = 1
                    lines[index] = "RECOVERY_EVENT " + json.dumps(event)
                    break
        self.console.write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.data["evidence"]["console_sha256"] = hashlib.sha256(self.console.read_bytes()).hexdigest()
        self.save_trace()
        with self.assertRaisesRegex(ValueError, "events differ"):
            export(self.trace)

    def test_console_path_traversal_is_rejected(self):
        self.data["evidence"]["console"] = "../outside.log"
        self.save_trace()
        with self.assertRaisesRegex(ValueError, "filename beside"):
            export(self.trace)

    def test_source_snapshot_drift_is_rejected(self):
        if "source_snapshot" not in self.data["evidence"]:
            self.skipTest("Legacy recording has no source snapshot")
        self.source.write_bytes(self.source.read_bytes() + b"\n/* changed after build */\n")
        with self.assertRaisesRegex(ValueError, "Source snapshot SHA-256 mismatch"):
            export(self.trace)


if __name__ == "__main__":
    unittest.main()

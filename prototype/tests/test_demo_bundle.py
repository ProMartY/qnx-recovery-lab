"""Portable-demo integrity tests with actual archived evidence and small test UI assets."""

import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import zipfile


PROTOTYPE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROTOTYPE))
from build_demo import CSS_TAG, JS_TAG, RECORDINGS, build_bundle, offline_html, script_json


class DemoBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.artifacts = self.root / "artifacts"
        self.demo = self.root / "demo"
        self.archive = self.root / "qnx-recovery-demo.zip"
        self.artifacts.mkdir()
        self.demo.mkdir()
        for filename, _ in RECORDINGS.values():
            trace = PROTOTYPE / "artifacts" / filename
            data = json.loads(trace.read_text(encoding="utf-8-sig"))
            for name in (filename, data["evidence"]["console"], data["evidence"]["source_snapshot"]):
                shutil.copyfile(PROTOTYPE / "artifacts" / name, self.artifacts / name)
        self.index = '<!doctype html><html><head>' + CSS_TAG + '</head><body><main>Test UI</main>' + JS_TAG + '</body></html>'
        (self.demo / "index.html").write_text(self.index, encoding="utf-8")
        (self.demo / "demo.css").write_text("body { color: #123; }", encoding="utf-8")
        (self.demo / "demo.js").write_text("window.demoReady = true;", encoding="utf-8")

    def build(self, **kwargs):
        return build_bundle(self.artifacts, self.demo, self.archive, **kwargs)

    def test_actual_recordings_are_verified_and_copied_exactly(self):
        manifest = self.build()
        self.assertEqual(manifest["mode"], "recorded")
        self.assertEqual(manifest["recordings"]["baseline"]["outcomes"],
                         {"contained": 1, "healthy": 1, "recovered": 5})
        self.assertEqual(manifest["recordings"]["no_restarts"]["outcomes"],
                         {"contained": 6, "healthy": 1})
        for role, (source_name, checksum) in RECORDINGS.items():
            recording = manifest["recordings"][role]
            contents = (self.demo / recording["file"]).read_bytes()
            self.assertEqual(contents, (self.artifacts / source_name).read_bytes())
            self.assertEqual(hashlib.sha256(contents).hexdigest(), checksum)
            receipt = recording["evidence"]
            self.assertEqual(receipt["checks"]["raw_console_correspondence"], "passed")
            for file_key, hash_key in (("console_log", "console_sha256"),
                                       ("source_file", "source_sha256"), ("report", "report_sha256")):
                self.assertEqual(hashlib.sha256((self.demo / receipt[file_key]).read_bytes()).hexdigest(),
                                 receipt[hash_key])

    def test_zip_uses_an_explicit_allowlist_and_is_reproducible(self):
        (self.demo / "license.dat").write_bytes(b"unrelated")
        (self.demo / "qnx.ifs").write_bytes(b"unrelated")
        (self.artifacts / "disk.img").write_bytes(b"unrelated")
        manifest = self.build()
        first = self.archive.read_bytes()
        self.build()
        self.assertEqual(first, self.archive.read_bytes())
        expected = {"index.html", "demo.css", "demo.js", "offline.html", "manifest.json", "README.md"}
        for recording in manifest["recordings"].values():
            evidence = recording["evidence"]
            expected.update((recording["file"], evidence["console_log"], evidence["source_file"], evidence["report"]))
        with zipfile.ZipFile(self.archive) as archive:
            self.assertEqual(set(archive.namelist()), expected)
            self.assertIsNone(archive.testzip())
            self.assertEqual(json.loads(archive.read("manifest.json")), manifest)

    def test_bad_evidence_preserves_all_published_outputs(self):
        self.build()
        published = {path: path.read_bytes() for path in self.demo.rglob("*") if path.is_file()}
        published[self.archive] = self.archive.read_bytes()
        filename, _ = RECORDINGS["baseline"]
        data = json.loads((self.artifacts / filename).read_text(encoding="utf-8-sig"))
        original = {}
        for name in (filename, data["evidence"]["console"], data["evidence"]["source_snapshot"]):
            path = self.artifacts / name
            original[path] = path.read_bytes()
        mutations = (
            (self.artifacts / filename, b"{invalid JSON"),
            (self.artifacts / data["evidence"]["console"], b"RECOVERY_RUN_EXIT=1\n"),
            (self.artifacts / data["evidence"]["source_snapshot"], b"/* modified source */\n"),
        )
        for path, contents in mutations:
            with self.subTest(file=path.name):
                path.write_bytes(contents)
                with self.assertRaises(ValueError):
                    self.build()
                self.assertEqual({item: item.read_bytes() for item in published}, published)
                path.write_bytes(original[path])

    def test_explicit_trace_override_still_checks_recorded_evidence(self):
        filename, _ = RECORDINGS["baseline"]
        trace = self.artifacts / filename
        data = json.loads(trace.read_text(encoding="utf-8-sig"))
        data["events"][0]["reason"] = "mismatched raw recording"
        trace.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "raw guest console"):
            self.build(baseline=trace)
        self.assertFalse(self.archive.exists())
        self.assertFalse((self.demo / "manifest.json").exists())

    def test_wrong_recording_role_is_rejected(self):
        boundary = self.artifacts / RECORDINGS["no_restarts"][0]
        with self.assertRaisesRegex(ValueError, "restart configuration"):
            self.build(baseline=boundary)

    def test_recomputed_digest_cannot_hide_raw_event_type_drift(self):
        trace = self.artifacts / RECORDINGS["baseline"][0]
        data = json.loads(trace.read_text(encoding="utf-8-sig"))
        console = self.artifacts / data["evidence"]["console"]
        lines = console.read_text(encoding="utf-8-sig").splitlines()
        for index, line in enumerate(lines):
            if line.startswith("RECOVERY_EVENT "):
                event = json.loads(line[len("RECOVERY_EVENT "):])
                if event["event"] == "summary":
                    event["passed"] = 1
                    lines[index] = "RECOVERY_EVENT " + json.dumps(event)
                    break
        console.write_text("\n".join(lines) + "\n", encoding="utf-8")
        data["evidence"]["console_sha256"] = hashlib.sha256(console.read_bytes()).hexdigest()
        trace.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "JSON events differ from the raw guest console"):
            self.build(baseline=trace)
        self.assertFalse(self.archive.exists())

    def test_policy_comparison_rejects_confounded_parameters(self):
        with self.assertRaisesRegex(ValueError, "differ in fault_at"):
            self.build(baseline=PROTOTYPE / "tests/fixtures/run-20261122-010323-961.json",
                       no_restarts=PROTOTYPE / "tests/fixtures/run-20261122-010218-294.json")
        self.assertFalse(self.archive.exists())

    def test_embedded_untrusted_strings_cannot_close_the_script_element(self):
        payload = {"text": '</ScRiPt><script>alert("x")</script>&\u2028\u2029'}
        encoded = script_json(payload)
        self.assertNotIn("<", encoded)
        self.assertNotIn("&", encoded)
        self.assertEqual(json.loads(encoded), payload)
        page = offline_html(self.index, "body{}", "window.demoReady=true;", payload, payload).decode("utf-8")
        self.assertEqual(page.lower().count("</script>"), 2)
        self.assertNotIn('</ScRiPt><script>alert("x")', page)
        self.assertNotIn('src="./demo.js"', page)
        self.assertNotIn('href="./demo.css"', page)

    def test_reviewed_font_is_embedded_and_keeps_its_license(self):
        fonts = self.demo / "fonts"
        fonts.mkdir()
        raw = b"wOF2synthetic-font-fixture"
        (fonts / "inter-tight-latin-wght-normal.woff2").write_bytes(raw)
        (fonts / "OFL.txt").write_text("Fixture copyright\nSIL OPEN FONT LICENSE Version 1.1\n", encoding="utf-8")
        (fonts / "SOURCE.txt").write_text("Synthetic packaging fixture, not a deployable font.", encoding="utf-8")
        (self.demo / "demo.css").write_text('@font-face{src:url("./fonts/inter-tight-latin-wght-normal.woff2")}', encoding="utf-8")
        manifest = self.build()
        with zipfile.ZipFile(self.archive) as archive:
            page = archive.read("offline.html").decode("utf-8")
            self.assertIn("data:font/woff2;base64,", page)
            self.assertIn("Fixture copyright", page)
            self.assertNotIn('url("./fonts/', page)
            self.assertEqual(archive.read("fonts/inter-tight-latin-wght-normal.woff2"), raw)
        self.assertEqual(manifest["assets"]["fonts/inter-tight-latin-wght-normal.woff2"]["sha256"], hashlib.sha256(raw).hexdigest())

    def test_native_receipt_cannot_be_attached_to_another_video(self):
        self.build()
        previous = self.archive.read_bytes()
        media = self.demo / "media"
        media.mkdir()
        (media / "demo.webm").write_bytes(b"\x1a\x45\xdf\xa3synthetic-video")
        (self.artifacts / "demo-native-capture.json").write_text(
            json.dumps({"video_sha256": "0" * 64}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "different video"):
            self.build(include_media=True)
        self.assertEqual(self.archive.read_bytes(), previous)

    def test_remote_assets_and_unsafe_tags_fail_before_publication(self):
        cases = (
            ("demo.css", "@import 'https://example.com/style.css';"),
            ("demo.css", "body { background: url(https://example.com/image.png); }"),
            ("demo.js", "fetch('https://example.com/data');"),
            ("demo.js", "window.value='</ScRiPt>';"),
            ("index.html", self.index.replace("<main>", '<img src="https://example.com/a"><main>')),
        )
        for filename, contents in cases:
            with self.subTest(file=filename, contents=contents):
                path = self.demo / filename
                original = path.read_bytes()
                path.write_text(contents, encoding="utf-8")
                with self.assertRaises(ValueError):
                    self.build()
                self.assertFalse(self.archive.exists())
                path.write_bytes(original)

    def test_media_is_explicit_allowlisted_and_hashed(self):
        media = self.demo / "media"
        media.mkdir()
        video = b"\x1a\x45\xdf\xa3test-container-header"
        (media / "demo.webm").write_bytes(video)
        (media / "demo.vtt").write_text("WEBVTT\n\n", encoding="utf-8")
        (media / "other.mp4").write_bytes(b"unrelated")
        self.assertEqual(self.build()["media"], [])
        self.assertFalse((self.demo / "video.html").exists())
        manifest = self.build(include_media=True)
        self.assertEqual({row["file"] for row in manifest["media"]}, {"media/demo.webm", "media/demo.vtt"})
        with zipfile.ZipFile(self.archive) as archive:
            self.assertEqual(archive.read("media/demo.webm"), video)
            self.assertNotIn("media/other.mp4", archive.namelist())
            page = archive.read("video.html").decode("utf-8")
            self.assertIn('<video controls preload="metadata" playsinline', page)
            self.assertIn('<source src="./media/demo.webm" type="video/webm">', page)
            self.assertIn('<track src="./media/demo.vtt" kind="captions" srclang="en" label="English" default>', page)
            self.assertIn('href="./offline.html"', page)
            self.assertNotIn('poster="', page)
            self.assertNotIn("http://", page)
            self.assertNotIn("https://", page)
            self.assertIn("./video.html", archive.read("README.md").decode("utf-8"))
            self.assertIn("python prototype/serve.py", archive.read("README.md").decode("utf-8"))
        row = next(row for row in manifest["media"] if row["file"].endswith("webm"))
        self.assertEqual(row["sha256"], hashlib.sha256(video).hexdigest())
        self.assertEqual(row["size_bytes"], len(video))
        poster = b"\x89PNG\r\n\x1a\ntest-image-header"
        (media / "demo-poster.png").write_bytes(poster)
        manifest = self.build(include_media=True)
        row = next(row for row in manifest["media"] if row["type"] == "image/png")
        self.assertEqual(row["file"], "media/demo-poster.png")
        self.assertEqual(row["sha256"], hashlib.sha256(poster).hexdigest())
        self.assertEqual(row["size_bytes"], len(poster))
        with zipfile.ZipFile(self.archive) as archive:
            self.assertEqual(archive.read("media/demo-poster.png"), poster)
            self.assertIn('poster="./media/demo-poster.png"', archive.read("video.html").decode("utf-8"))


if __name__ == "__main__":
    unittest.main()

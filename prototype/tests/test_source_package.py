"""Publication-boundary checks for reviewed local source packages."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.package_source import audit_file, package


class SourcePackageTests(unittest.TestCase):
    def test_local_tools_keys_and_executables_are_excluded(self):
        for name in ("work/tool.txt", ".git/config", "src/key.pem", "image.raw", "outputs/history.md", "AGENTS.md"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                audit_file(name, b"local data")
        for raw in (b"MZbinary", b"\x7fELFbinary"):
            with self.assertRaisesRegex(ValueError, "Executable content"):
                audit_file("innocent.txt", raw)

    def test_private_details_are_reported_without_echoing_the_value(self):
        examples = ("C:" + "/Users/" + "example/private", "someone" + "@" + "gmail.com", "ABCD-" * 4 + "ABCD")
        for example in examples:
            with self.assertRaises(ValueError) as caught:
                audit_file("notes.md", example.encode())
            self.assertNotIn(example, str(caught.exception))

    def test_package_includes_only_indexed_files_with_correct_digests(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            for name in ("README.md", "LICENSE"):
                (root / name).write_text("Reviewed project text\n", encoding="utf-8")
            (root / "private.txt").write_text("not staged", encoding="utf-8")
            subprocess.run(["git", "-C", str(root), "add", "README.md", "LICENSE"], check=True)
            output = root / "source.zip"
            package(root, output)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(set(archive.namelist()), {"README.md", "LICENSE", "SOURCE-MANIFEST.json"})
                manifest = json.loads(archive.read("SOURCE-MANIFEST.json"))
                self.assertEqual(manifest["files"]["README.md"]["sha256"], hashlib.sha256(archive.read("README.md")).hexdigest())
            original = output.read_bytes()
            (root / "README.md").write_text("unreviewed change", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "differ from the index"):
                package(root, output)
            self.assertEqual(output.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()

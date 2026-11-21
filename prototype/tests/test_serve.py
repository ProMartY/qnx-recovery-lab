"""Check video seeking responses and static-file containment over loopback HTTP."""

import http.client
import io
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve import RangeRequestHandler, create_server


class VideoRangeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.root = self.folder / "site"
        self.root.mkdir()
        self.content = b"0123456789abcdefghij"
        (self.root / "demo.webm").write_bytes(self.content)
        (self.root / "demo.mp4").write_bytes(self.content)
        (self.root / "notes.txt").write_bytes(b"ordinary static file")
        (self.root / "empty.webm").write_bytes(b"")
        logging = patch.object(RangeRequestHandler, "log_message")
        logging.start()
        self.addCleanup(logging.stop)
        self.server = create_server(self.root, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def request(self, path, range_header=None, method="GET"):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        headers = {} if range_header is None else {"Range": range_header}
        try:
            connection.request(method, path, headers=headers)
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def test_full_video_get_and_head_advertise_ranges(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        for extension, media_type in (("webm", "video/webm"), ("mp4", "video/mp4")):
            with self.subTest(extension=extension):
                status, headers, body = self.request(f"/demo.{extension}")
                self.assertEqual(status, 200)
                self.assertEqual(body, self.content)
                self.assertEqual(headers["Content-Length"], str(len(self.content)))
                self.assertEqual(headers["Accept-Ranges"], "bytes")
                self.assertEqual(headers["Content-Type"], media_type)
                status, headers, body = self.request(f"/demo.{extension}", method="HEAD")
                self.assertEqual(status, 200)
                self.assertEqual(body, b"")
                self.assertEqual(headers["Content-Length"], str(len(self.content)))
                self.assertEqual(headers["Accept-Ranges"], "bytes")

    def test_closed_open_and_suffix_ranges_return_exact_bytes(self):
        cases = (
            ("bytes=2-5", 2, 5),
            ("bytes=15-", 15, 19),
            ("bytes=-4", 16, 19),
            ("bytes=18-99", 18, 19),
            ("bytes=-100", 0, 19),
            ("bytes=0-0", 0, 0),
        )
        for extension in ("webm", "mp4"):
            for value, start, end in cases:
                with self.subTest(extension=extension, range=value):
                    status, headers, body = self.request(f"/demo.{extension}", value)
                    self.assertEqual(status, 206)
                    self.assertEqual(body, self.content[start:end + 1])
                    self.assertEqual(headers["Content-Length"], str(end - start + 1))
                    self.assertEqual(headers["Content-Range"], f"bytes {start}-{end}/20")
                    self.assertEqual(headers["Accept-Ranges"], "bytes")

    def test_partial_head_returns_get_headers_without_body(self):
        status, headers, body = self.request("/demo.webm", "bytes=5-9", method="HEAD")
        self.assertEqual(status, 206)
        self.assertEqual(body, b"")
        self.assertEqual(headers["Content-Length"], "5")
        self.assertEqual(headers["Content-Range"], "bytes 5-9/20")
        self.assertEqual(headers["Accept-Ranges"], "bytes")

    def test_copy_stops_at_the_selected_byte_count(self):
        handler = object.__new__(RangeRequestHandler)
        handler.range_length = 3
        source = io.BytesIO(self.content * 10000)
        source.seek(2)
        output = io.BytesIO()
        handler.copyfile(source, output)
        self.assertEqual(output.getvalue(), self.content[2:5])
        self.assertEqual(source.tell(), 5)

    def test_invalid_or_unsatisfiable_ranges_return_416(self):
        for value in ("bytes=20-", "bytes=5-2", "bytes=-0", "bytes=-", "bytes=",
                      "bytes=0-1,3-4", "items=0-3", "bytes=one-two", "bytes=-1-4"):
            for method in ("GET", "HEAD"):
                with self.subTest(range=value, method=method):
                    status, headers, body = self.request("/demo.webm", value, method)
                    self.assertEqual(status, 416)
                    self.assertEqual(body, b"")
                    self.assertEqual(headers["Content-Range"], "bytes */20")
                    self.assertEqual(headers["Content-Length"], "0")
                    self.assertEqual(headers["Accept-Ranges"], "bytes")

    def test_empty_video_cannot_satisfy_a_range(self):
        status, headers, body = self.request("/empty.webm", "bytes=0-")
        self.assertEqual(status, 416)
        self.assertEqual(headers["Content-Range"], "bytes */0")
        self.assertEqual(body, b"")
        status, headers, body = self.request("/empty.webm")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Length"], "0")
        self.assertEqual(body, b"")

    def test_other_static_files_keep_normal_serving(self):
        status, headers, body = self.request("/notes.txt", "bytes=0-2")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"ordinary static file")
        self.assertIsNone(headers.get("Content-Range"))

    def test_symlink_outside_root_is_denied(self):
        secret = self.folder / "secret.txt"
        secret.write_bytes(b"outside root")
        link = self.root / "linked.webm"
        try:
            link.symlink_to(secret)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"Symbolic links are unavailable: {error}")
        for method in ("GET", "HEAD"):
            with self.subTest(method=method):
                status, _, body = self.request("/linked.webm", "bytes=0-3", method)
                self.assertEqual(status, 403)
                self.assertNotIn(b"outside root", body)

    def test_directory_index_symlink_cannot_bypass_containment(self):
        secret = self.folder / "secret-index.html"
        secret.write_bytes(b"private index contents")
        try:
            (self.root / "index.html").symlink_to(secret)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"Symbolic links are unavailable: {error}")
        status, _, body = self.request("/")
        self.assertEqual(status, 403)
        self.assertNotIn(b"private index contents", body)


if __name__ == "__main__":
    unittest.main()

"""Serve the local Recovery Lab viewer with seekable video responses."""

import argparse
import os
import re
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
VIDEO_EXTENSIONS = {".webm", ".mp4"}


def parse_range(value, size):
    """Return inclusive byte bounds for a single satisfiable HTTP range."""
    match = re.fullmatch(r"bytes=([0-9]*)-([0-9]*)", value.strip(), re.IGNORECASE)
    if match is None or size == 0:
        raise ValueError("Invalid or unsatisfiable byte range")
    start_text, end_text = match.groups()
    if not start_text:
        suffix = int(end_text)
        if suffix <= 0:
            raise ValueError("Invalid suffix length")
        return max(0, size - suffix), size - 1
    start = int(start_text)
    end = int(end_text) if end_text else size - 1
    if start >= size or end < start:
        raise ValueError("Unsatisfiable byte range")
    return start, min(end, size - 1)


class RangeRequestHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webm": "video/webm",
        ".mp4": "video/mp4",
    }

    def __init__(self, *args, directory=ROOT, **kwargs):
        self.root = Path(directory).resolve()
        self.video_response = False
        self.range_length = None
        super().__init__(*args, directory=str(self.root), **kwargs)

    def translate_path(self, path):
        resolved = Path(super().translate_path(path)).resolve()
        if not resolved.is_relative_to(self.root):
            raise PermissionError("Requested path is outside the server root")
        return str(resolved)

    def send_head(self):
        self.video_response = False
        self.range_length = None
        try:
            path = Path(self.translate_path(self.path))
            if path.is_dir():
                # The base handler opens an index directly, without translate_path().
                for name in self.index_pages:
                    index = path / name
                    if index.is_file():
                        if not index.resolve().is_relative_to(self.root):
                            raise PermissionError("Directory index is outside the server root")
                        break
            self.video_response = path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS
            ranges = self.headers.get_all("Range")
            if self.video_response and ranges is not None:
                return self.send_range(path, ranges)
            return super().send_head()
        except (PermissionError, RuntimeError):
            self.send_error(HTTPStatus.FORBIDDEN, "Requested path is outside the server root")
            return None

    def end_headers(self):
        if self.video_response:
            self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_range(self, path, ranges):
        try:
            source = path.open("rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None
        try:
            stat = os.fstat(source.fileno())
            try:
                if len(ranges) != 1:
                    raise ValueError("Multiple range headers are unsupported")
                start, end = parse_range(ranges[0], stat.st_size)
            except ValueError:
                source.close()
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{stat.st_size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None
            source.seek(start)
            self.range_length = end - start + 1
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Type", self.guess_type(str(path)))
            self.send_header("Content-Range", f"bytes {start}-{end}/{stat.st_size}")
            self.send_header("Content-Length", str(self.range_length))
            self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
            self.end_headers()
            return source
        except BaseException:
            source.close()
            raise

    def copyfile(self, source, outputfile):
        if self.range_length is None:
            return super().copyfile(source, outputfile)
        remaining = self.range_length
        while remaining:
            data = source.read(min(64 * 1024, remaining))
            if not data:
                break
            outputfile.write(data)
            remaining -= len(data)


def create_server(directory=ROOT, port=8764):
    root = Path(directory).resolve()
    if not root.is_dir():
        raise ValueError("Server root must be an existing directory")
    handler = partial(RangeRequestHandler, directory=root)
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8764)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    with create_server(port=args.port) as server:
        print(f"Recovery Lab viewer http://127.0.0.1:{args.port}/viewer/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()

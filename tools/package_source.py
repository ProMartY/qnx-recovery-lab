"""Audit tracked source and build a ZIP without local tools, credentials or Git metadata."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_DIRECTORIES = {".git", ".qnx", "work", "outputs", "node_modules", "__pycache__"}
FORBIDDEN_SUFFIXES = {".o", ".obj", ".exe", ".dll", ".bin", ".raw", ".qcow2", ".key", ".pem", ".license", ".zip"}
PATTERNS = (
    ("private key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("access token", re.compile(r"\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b")),
    ("license-like key", re.compile(r"\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){4}\b")),
    ("personal Windows path", re.compile(r"[A-Za-z]:[/\\]Users[/\\]", re.I)),
    ("personal email", re.compile(r"\b[A-Z0-9._%+\-]+@(?:gmail|hotmail|outlook|yahoo|icloud)\.com\b", re.I)),
)


def audit_file(name, contents):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError(f"Unsafe source path: {name}")
    if any(part.lower() in FORBIDDEN_DIRECTORIES for part in path.parts):
        raise ValueError(f"Local-only directory in tracked source: {name}")
    if path.name == "AGENTS.md" or path.name.startswith(".env") or path.suffix.lower() in FORBIDDEN_SUFFIXES:
        raise ValueError(f"Excluded local or binary file in tracked source: {name}")
    if contents.startswith((b"\x7fELF", b"MZ")):
        raise ValueError(f"Executable content in tracked source: {name}")
    if path.suffix.lower() in {".png", ".jpg", ".webm"}:
        return
    try:
        text = contents.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValueError(f"Unreviewed binary content: {name}") from None
    for label, pattern in PATTERNS:
        if pattern.search(text):
            raise ValueError(f"Possible {label} in {name}; review before packaging")


def git(root, *arguments):
    return subprocess.check_output(["git", "-C", str(root), *arguments], stderr=subprocess.PIPE)


def collect(root):
    root = Path(root).resolve()
    names = git(root, "ls-files", "-z").decode("utf-8").split("\0")
    names = sorted(name for name in names if name)
    if not names:
        raise ValueError("No reviewed files are staged or tracked")
    if subprocess.run(["git", "-C", str(root), "diff", "--quiet"], check=False).returncode:
        raise ValueError("Tracked working files differ from the index; stage reviewed changes first")
    files = {}
    for name in names:
        path = (root / name).resolve()
        if not path.is_relative_to(root) or (root / name).is_symlink():
            raise ValueError(f"Source path leaves the repository or is a symlink: {name}")
        contents = path.read_bytes()
        audit_file(name, contents)
        files[name] = contents
    if "LICENSE" not in files or "README.md" not in files:
        raise ValueError("A source package needs LICENSE and README.md")
    return files


def package(root=ROOT, destination=None, check_only=False):
    root = Path(root).resolve()
    files = collect(root)
    if check_only:
        return {"files": len(files), "bytes": sum(map(len, files.values())), "audit": "passed"}
    destination = Path(destination or root / "outputs/qnx-recovery-lab-source.zip").resolve()
    if destination.suffix.lower() != ".zip":
        raise ValueError("Source package output must be a .zip file")
    head = subprocess.run(["git", "-C", str(root), "rev-parse", "--verify", "HEAD"], capture_output=True, text=True)
    manifest = {
        "schema_version": 1,
        "commit": head.stdout.strip() if head.returncode == 0 else None,
        "note": "Reviewed tracked files. Digests check consistency, not independent execution.",
        "files": {name: {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
                  for name, raw in files.items()},
    }
    files["SOURCE-MANIFEST.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, contents in sorted(files.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, contents)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as stream:
        pending = Path(stream.name)
        stream.write(buffer.getvalue())
    try:
        os.replace(pending, destination)
    finally:
        pending.unlink(missing_ok=True)
    return {"files": len(files), "zip_bytes": destination.stat().st_size, "output": str(destination), "audit": "passed"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(package(destination=args.output, check_only=args.check)))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Source packaging failed: {error}\n")


if __name__ == "__main__":
    main()

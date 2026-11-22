"""Build a portable, verified playback of two pinned QNX guest recordings."""

import argparse
import base64
from collections import Counter
import hashlib
from html.parser import HTMLParser
import io
import json
import os
from pathlib import Path
import re
import tempfile
import zipfile

from check_trace import require, validate_trace
from export_report import markdown, verify_console


PROTOTYPE = Path(__file__).resolve().parent
RECORDINGS = {
    "baseline": ("run-20261122-011701-835.json",
                 "b4bc6afa8040a1a8c365534439de0e8dda98d36d93cc6e3bfbcefb539196aac4"),
    "no_restarts": ("run-20261122-011927-411.json",
                    "199e6d0dcf858340e329f6bd53ac1c5544001118a24dd76fffee91850706f4a1"),
}
DATA_FILES = {"baseline": "data/baseline.json", "no_restarts": "data/no-restarts.json"}
CSS_TAG = '<link rel="stylesheet" href="./demo.css">'
JS_TAG = '<script src="./demo.js"></script>'
UI_FILES = ("index.html", "demo.css", "demo.js")
FONT_FILES = ("fonts/inter-tight-latin-wght-normal.woff2", "fonts/OFL.txt", "fonts/SOURCE.txt")
MEDIA_FILES = {"demo.mp4": "video/mp4", "demo.webm": "video/webm", "demo.vtt": "text/vtt",
               "demo-poster.png": "image/png"}


def sha256(contents):
    return hashlib.sha256(contents).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")


def script_json(value):
    """Keep untrusted JSON strings inside their script element."""
    return json.dumps(value, ensure_ascii=True, allow_nan=False).replace(
        "<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


class ResourceCheck(HTMLParser):
    def __init__(self, offline):
        super().__init__()
        self.offline = offline

    def handle_starttag(self, tag, attributes):
        values = dict(attributes)
        if tag == "script" and "src" in values:
            require(not self.offline and values["src"] == "./demo.js",
                    "Demo contains an unexpected script resource")
        elif tag == "link" and "href" in values:
            require(not self.offline and values["href"] == "./demo.css"
                    and values.get("rel") == "stylesheet",
                    "Demo contains an unexpected linked resource")
        elif tag in ("img", "video", "audio", "source", "iframe", "embed", "object"):
            require(not any(key in values for key in ("src", "srcset", "data", "poster")),
                    "Demo contains an external media resource")
        require("style" not in values or not re.search(r"url\s*\(|@import", values["style"], re.I),
                "Demo contains an inline stylesheet resource")


def read_ui(demo):
    assets = {name: (demo / name).read_bytes() for name in UI_FILES}
    text = {name: contents.decode("utf-8-sig") for name, contents in assets.items()}
    require(text["index.html"].count(CSS_TAG) == text["index.html"].count(JS_TAG) == 1,
            "Demo must contain exactly the supported local CSS and JavaScript tags")
    ResourceCheck(offline=False).feed(text["index.html"])
    css_resources = text["demo.css"].replace('url("./fonts/inter-tight-latin-wght-normal.woff2")', '')
    require(not re.search(r"@import|url\s*\(", css_resources, re.I),
            "Demo stylesheet may only use the reviewed local font")
    if 'url("./fonts/inter-tight-latin-wght-normal.woff2")' in text["demo.css"]:
        for name in FONT_FILES:
            assets[name] = (demo / name).read_bytes()
        require(assets[FONT_FILES[0]].startswith(b"wOF2"), "Invalid local WOFF2 font")
        require(b"SIL OPEN FONT LICENSE" in assets["fonts/OFL.txt"], "Missing font license")
    require(not re.search(r"</style", text["demo.css"], re.I), "Unsafe closing style tag in CSS")
    require(not re.search(r"</script", text["demo.js"], re.I), "Unsafe closing script tag in JavaScript")
    require(not re.search(r"(?:https?:)?//[^\s'\"<>]+", text["demo.js"]),
            "Demo JavaScript must use local resources")
    return assets, text


def verified_recording(artifacts, role, selected_trace=None):
    name, expected_hash = RECORDINGS[role]
    trace = Path(selected_trace).resolve() if selected_trace is not None else artifacts / name
    require(re.fullmatch(r"run-\d{8}-\d{6}-\d{3}\.json", trace.name) is not None,
            "Demo trace must use a recorded run filename")
    contents = trace.read_bytes()
    checksum = sha256(contents)
    if selected_trace is None:
        require(checksum == expected_hash, f"Pinned {role} trace SHA-256 mismatch")
    data = json.loads(contents.decode("utf-8-sig"))
    names = validate_trace(data)
    require(len(names) == 7 and data["config"]["scenario"] == "all",
            f"Pinned {role} recording must contain the seven-scenario suite")
    require((data["config"]["restart_limit"] == 0) == (role == "no_restarts"),
            f"{role} recording has an incompatible restart configuration")
    console, console_hash = verify_console(trace, data)
    evidence = data["evidence"]
    require("source_snapshot" in evidence, f"Pinned {role} recording has no source snapshot")
    source = trace.parent / evidence["source_snapshot"]
    require(source.suffix == ".c", "Demo source snapshot must be a C source file")
    console_bytes = console.read_bytes()
    source_bytes = source.read_bytes()
    source_bytes.decode("utf-8-sig")
    require(sha256(console_bytes) == console_hash, f"{role} console changed during verification")
    require(sha256(source_bytes) == evidence["source_sha256"],
            f"{role} source changed during verification")
    evidence_dir = f"data/evidence/{role}"
    report = markdown(trace, data, console, console_hash, checksum).encode("utf-8")
    files = {
        DATA_FILES[role]: contents,
        f"{evidence_dir}/{console.name}": console_bytes,
        f"{evidence_dir}/{source.name}": source_bytes,
        f"{evidence_dir}/report.md": report,
    }
    receipt = {
        "verified": True,
        "console_log": f"{evidence_dir}/{console.name}",
        "console_sha256": console_hash,
        "source_file": f"{evidence_dir}/{source.name}",
        "source_sha256": evidence["source_sha256"],
        "report": f"{evidence_dir}/report.md",
        "report_sha256": sha256(report),
        "checks": {
            "trace_sha256": "matched_reference_pin" if selected_trace is None else "recorded_explicit_input",
            "event_invariants": "passed",
            "raw_console_correspondence": "passed",
            "console_sha256": "passed",
            "source_snapshot_sha256": "passed",
            "guest_exit_markers": "passed",
        },
    }
    recording = {
        "file": DATA_FILES[role],
        "source_file": trace.name,
        "source_trace": trace.name,
        "sha256": checksum,
        "event_count": len(data["events"]),
        "scenario_count": len(names),
        "config": data["config"],
        "recorded_at": data["recorded_at"],
        "outcomes": dict(sorted(Counter(row["outcome"] for row in data["scenarios"]).items())),
        "evidence": receipt,
    }
    return data, recording, files


def read_media(demo):
    files = {}
    metadata = []
    for name, media_type in MEDIA_FILES.items():
        path = demo / "media" / name
        if not path.exists():
            continue
        contents = path.read_bytes()
        if name.endswith(".mp4"):
            require(len(contents) >= 12 and contents[4:8] == b"ftyp", "Invalid demo MP4 header")
        elif name.endswith(".webm"):
            require(contents.startswith(b"\x1a\x45\xdf\xa3"), "Invalid demo WebM header")
        elif name.endswith(".png"):
            require(contents.startswith(b"\x89PNG\r\n\x1a\n"), "Invalid demo poster PNG header")
        else:
            require(contents.decode("utf-8-sig").startswith("WEBVTT"), "Invalid demo caption header")
        relative = "media/" + name
        files[relative] = contents
        metadata.append({"file": relative, "sha256": sha256(contents),
                         "size_bytes": len(contents), "type": media_type})
    require(any(row["type"].startswith("video/") for row in metadata),
            "--include-media requires demo/media/demo.mp4 or demo.webm")
    return files, metadata


def offline_html(index, css, javascript, recordings, manifest, fonts=None):
    font_notice = ''
    if fonts:
        encoded = base64.b64encode(fonts[FONT_FILES[0]]).decode('ascii')
        css = css.replace('url("./fonts/inter-tight-latin-wght-normal.woff2")',
                          'url("data:font/woff2;base64,' + encoded + '")')
        # Keep the font copyright and license with the self-contained distribution.
        notice = (fonts['fonts/OFL.txt'] + b'\n' + fonts['fonts/SOURCE.txt']).decode('utf-8-sig')
        font_notice = '<!-- Bundled font license and source\n' + notice.replace('-->', '-- >') + '\n-->\n'
    globals_script = "<script>\nwindow.RECOVERY_DEMO_DATA=" + script_json(recordings) + ";\n"
    globals_script += "window.RECOVERY_DEMO_MANIFEST=" + script_json(manifest) + ";\n</script>\n"
    result = index.replace(CSS_TAG, font_notice + "<style>\n" + css + "\n</style>", 1)
    result = result.replace(JS_TAG, globals_script + "<script>\n" + javascript + "\n</script>", 1)
    ResourceCheck(offline=True).feed(result)
    return result.encode("utf-8")


def video_html(media):
    sources = []
    captions = ""
    poster = ""
    for row in media:
        filename = row["file"]
        require(filename in {"media/" + name for name in MEDIA_FILES}, "Unexpected video-page resource")
        require(row["type"] == MEDIA_FILES[Path(filename).name], "Unexpected video-page media type")
        if row["type"].startswith("video/"):
            sources.append(f'      <source src="./{filename}" type="{row["type"]}">')
        elif row["type"] == "text/vtt":
            captions = '      <track src="./media/demo.vtt" kind="captions" srclang="en" label="English" default>'
        else:
            poster = ' poster="./media/demo-poster.png"'
    require(sources, "Video page requires a recorded video")
    page = '''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Recorded walkthrough · QNX Recovery Lab</title>
  <style>
    @font-face { font-family:"Inter Tight"; font-style:normal; font-weight:100 900; font-display:swap; src:url("./fonts/inter-tight-latin-wght-normal.woff2") format("woff2"); }
    :root { color-scheme:dark; --paper:#0c0e10; --ink:#f0f2f4; --muted:#a3adb7; --blue:#ff7049; --line:#30363c; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--paper); color:var(--ink); font:16px/1.6 "Inter Tight","Segoe UI",Arial,sans-serif; }
    a { color:var(--blue); text-underline-offset:4px; }
    a:focus-visible,video:focus-visible { outline:3px solid var(--blue); outline-offset:5px; }
    .shell { width:min(1380px,100%); margin:auto; padding:0 40px; }
    header { min-height:88px; display:flex; align-items:center; justify-content:space-between; gap:20px; border-bottom:1px solid var(--line); }
    .brand { color:var(--ink); text-decoration:none; font-size:18px; font-weight:650; letter-spacing:-.5px; }
    .brand { display:flex; align-items:center; gap:12px; font-size:25px; letter-spacing:-1px; }
    .brand span { display:inline-flex; align-items:center; gap:4px; height:28px; }
    .brand i { width:6px; height:19px; background:var(--ink); border-radius:1px; }
    .brand i:nth-child(2) { height:28px; background:var(--blue); }
    .brand i:nth-child(3) { height:12px; align-self:end; }
    .status { font:12px/1.4 Consolas,monospace; text-transform:uppercase; letter-spacing:1px; color:var(--muted); }
    .intro { display:grid; grid-template-columns:1fr minmax(250px,440px); gap:32px; align-items:end; padding:44px 0 30px; }
    .eyebrow { margin:0 0 13px; font:11px Consolas,monospace; color:var(--blue); text-transform:uppercase; letter-spacing:1.6px; }
    h1 { margin:0; font-size:clamp(36px,4.7vw,64px); line-height:1.08; font-weight:550; letter-spacing:-2.5px; }
    .intro-copy { margin:0; color:var(--muted); font-size:15px; line-height:1.7; }
    .stage { background:#131619; padding:10px; border:1px solid var(--line); border-radius:10px; }
    video { display:block; width:100%; aspect-ratio:36/25; background:#0c0e10; border-radius:4px; }
    video::cue { font-size:18px; line-height:1.3; background:rgba(10,16,23,.88); }
    .recording-meta { display:flex; flex-wrap:wrap; justify-content:space-between; gap:12px; color:#c0ccd6; padding:15px 10px 5px; font:12px/1.5 Consolas,monospace; }
    .bottom { display:grid; grid-template-columns:1fr auto; align-items:center; gap:28px; padding:27px 0; }
    .bottom p { margin:0; color:var(--muted); max-width:740px; font-size:14px; }
    .action { display:inline-flex; align-items:center; padding:12px 17px; min-height:46px; border-radius:5px; background:var(--blue); color:#1c100b; text-decoration:none; font-size:15px; font-weight:650; white-space:nowrap; }
    .action:hover { background:#ff8969; }
    footer { border-top:1px solid var(--line); padding:22px 0 30px; font-size:12px; color:var(--muted); }
    @media(max-width:700px) { .shell{padding:0 18px}header{min-height:76px}.brand{font-size:15px}.status{font-size:9px;letter-spacing:.6px}.intro{grid-template-columns:1fr;padding:30px 0 23px;gap:20px}h1{letter-spacing:-1.5px}.intro-copy{font-size:14px}.stage{padding:7px;border-radius:11px}.recording-meta{font-size:10px;padding:11px 5px 5px}.bottom{grid-template-columns:1fr;gap:18px}.action{justify-self:start}video::cue{font-size:14px} }
    @media(prefers-reduced-motion:reduce) { *{scroll-behavior:auto} }
  </style>
</head>
<body>
  <div class="shell">
  <header><a class="brand" href="./offline.html"><span aria-hidden="true"><i></i><i></i><i></i></span>recoverylab</a><span class="status">Recorded walkthrough</span></header>
  <main>
    <div class="intro"><div><p class="eyebrow">QNX Recovery Lab / Demonstration</p><h1 id="videoTitle">Recovery,<br>on record.</h1></div>
    <p class="intro-copy" id="videoDescription">Follow a rejected message, a replacement worker, and a bounded restart policy. This screencast presents archived native QNX 8 guest events under QEMU.</p></div>
    <section class="stage" aria-label="Recorded demonstration video">
    <video controls preload="metadata" playsinline aria-labelledby="videoTitle" aria-describedby="videoDescription">
SOURCES
CAPTIONS
      Your browser can use the video files in the media directory.
    </video>
    <div class="recording-meta"><span>QNX 8 guest · QEMU software emulation</span><span id="clipDuration">Recorded UI replay</span></div>
    </section>
    <div class="bottom"><p>The numeric output is simulated. Guest timestamps describe the archived execution; playback time describes this walkthrough. Use the interactive demo to inspect each decision at your own pace.</p><a class="action" href="./offline.html">Open the interactive demo</a></div>
  </main>
  <footer>Original interface and recordings · Local evidence · No hardware timing guarantee</footer>
  </div>
  <script>
    const video = document.querySelector('video');
    video.addEventListener('loadedmetadata', () => {
      if (!Number.isFinite(video.duration)) return;
      const seconds = Math.round(video.duration);
      document.getElementById('clipDuration').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} walkthrough`;
    });
  </script>
</body>
</html>
'''
    return page.replace("SOURCES", "\n".join(sources)).replace("CAPTIONS", captions).replace(
        "playsinline aria-", "playsinline" + poster + " aria-", 1).encode("utf-8")


def readme(manifest):
    rows = [
        "# QNX Recovery Lab recorded demo", "",
        "Open offline.html directly to play the self-contained snapshot. "
        "For the served version, run `python -m http.server 8000` from this directory "
        "and open http://localhost:8000/.", "",
        "The interface replays two recorded QNX 8.0 guest runs under QEMU TCG on Windows. "
        "Playback controls move through recorded events. Output is a simulated actuator value.", "",
        "| Recording | Source trace | Events | Restart limit |", "|---|---|---:|---:|",
    ]
    for role, recording in manifest["recordings"].items():
        rows.append(f"| {role} | {recording['source_file']} | {recording['event_count']} "
                    f"| {recording['config']['restart_limit']} |")
    rows += [
        "", "The JSON traces are byte-for-byte copies of the pinned source files. "
        "Each data/evidence directory contains its original guest console, C source snapshot "
        "and a report generated after validation. manifest.json records their SHA-256 digests "
        "and the checks that passed.", "",
        "The builder checks event invariants, exact raw-console correspondence, both successful "
        "guest exit markers, trace digests and source-snapshot digests before publishing. "
        "Digests and matching records establish internal consistency. They provide no independent "
        "attestation of execution, hardware timing, physical I/O behavior or production safety.", "",
        "A separate workspace recording, run-20261122-011802-242.json, used a 300 ms watchdog "
        "and reported an unexpected healthy-scenario timeout after 332 ms without an accepted proposal "
        "during QEMU software emulation. That failed recording remains in the workspace history. "
        "This package selects the two verified recordings listed above for policy comparison.", "",
        "The package contains the demo interface, recordings, text evidence and any explicitly "
        "included browser screencast. Licensed SDK files, QNX executables and boot/disk images "
        "remain outside the package. Binary and image digests in the traces identify the recorded build inputs.", "",
        "The full-workspace viewer link requires the surrounding prototype directory when served. "
        "The portable snapshot plays independently.", "",
    ]
    if manifest["media"]:
        rows += ["[Watch the captioned browser screencast](./video.html). "
                 "Open video.html directly from this directory. "
                 "The media directory contains a browser screencast of recorded playback. "
                 "Its file digests and sizes are listed in manifest.json.", "",
                 "From the full workspace, run `python prototype/serve.py` and use the printed server address. "
                 "That server supports byte-range requests for video seeking. A basic HTTP server can play "
                 "the recording progressively. Seeking requires byte-range support or a fully buffered recording.", ""]
    return "\n".join(rows).encode("utf-8")


def prepare_bundle(artifacts, demo, include_media=False, baseline=None, no_restarts=None):
    assets, text = read_ui(demo)
    files = dict(assets)
    recordings = {}
    manifest = {
        "schema_version": 1,
        "mode": "recorded",
        "note": "Recorded QNX 8.0 guest execution under QEMU TCG on Windows; playback uses archived events.",
        "integrity": "Pinned input and internal-consistency checks; no independent execution attestation.",
        "recordings": {},
        "assets": {name: {"sha256": sha256(contents), "size_bytes": len(contents)}
                   for name, contents in assets.items()},
        "media": [],
    }
    selected = {"baseline": baseline, "no_restarts": no_restarts}
    for role in RECORDINGS:
        data, recording, evidence_files = verified_recording(artifacts, role, selected[role])
        recordings[role] = data
        manifest["recordings"][role] = recording
        files.update(evidence_files)
    for key in ("fault_at", "watchdog_ms"):
        require(recordings["baseline"]["config"][key] == recordings["no_restarts"]["config"][key],
                f"Demo recordings differ in {key}; comparison must vary only the restart budget")
    for key in ("os", "release"):
        require(recordings["baseline"]["environment"].get(key)
                == recordings["no_restarts"]["environment"].get(key),
                f"Demo recordings have different guest {key}")
    if include_media:
        media_files, manifest["media"] = read_media(demo)
        files.update(media_files)
        files["video.html"] = video_html(manifest["media"])
    files["manifest.json"] = json_bytes(manifest)
    fonts = {name: assets[name] for name in FONT_FILES} if FONT_FILES[0] in assets else None
    files["offline.html"] = offline_html(text["index.html"], text["demo.css"], text["demo.js"],
                                         recordings, manifest, fonts)
    files["README.md"] = readme(manifest)
    return files, manifest


def zip_bytes(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, contents in sorted(files.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, contents)
    return buffer.getvalue()


def build_bundle(artifacts=PROTOTYPE / "artifacts", demo=PROTOTYPE / "demo",
                 archive=PROTOTYPE / "artifacts/qnx-recovery-demo.zip", include_media=False,
                 baseline=None, no_restarts=None):
    artifacts, demo, archive = Path(artifacts).resolve(), Path(demo).resolve(), Path(archive).resolve()
    require(archive.suffix.lower() == ".zip", "Demo archive must have a .zip extension")
    files, manifest = prepare_bundle(artifacts, demo, include_media, baseline, no_restarts)
    archive_contents = zip_bytes(files)
    # Validate and construct every output before replacing any published file.
    outputs = {demo / name: contents for name, contents in files.items()
               if name not in UI_FILES and name not in FONT_FILES and not name.startswith("media/")}
    outputs[archive] = archive_contents
    with tempfile.TemporaryDirectory(prefix="qnx-demo-") as pending_directory:
        pending = []
        for index, (destination, contents) in enumerate(outputs.items()):
            staged = Path(pending_directory) / str(index)
            staged.write_bytes(contents)
            pending.append((staged, destination))
        for staged, destination in pending:
            destination.parent.mkdir(parents=True, exist_ok=True)
            # The staging directory and workspace may be on different Windows volumes.
            with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as stream:
                replacement = Path(stream.name)
                stream.write(staged.read_bytes())
            try:
                os.replace(replacement, destination)
            finally:
                replacement.unlink(missing_ok=True)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=PROTOTYPE / "artifacts")
    parser.add_argument("--demo", type=Path, default=PROTOTYPE / "demo")
    parser.add_argument("--archive", type=Path, default=PROTOTYPE / "artifacts/qnx-recovery-demo.zip")
    parser.add_argument("--include-media", action="store_true")
    parser.add_argument("--baseline", type=Path, help="Explicit baseline recording to verify and snapshot")
    parser.add_argument("--no-restarts", type=Path, help="Explicit zero-restart recording to verify and snapshot")
    args = parser.parse_args()
    try:
        manifest = build_bundle(args.artifacts, args.demo, args.archive, args.include_media,
                                args.baseline, args.no_restarts)
        print(f"Verified {sum(row['event_count'] for row in manifest['recordings'].values())} "
              f"recorded events across {len(manifest['recordings'])} snapshots")
        print(args.demo / "offline.html")
        print(args.archive)
    except (ValueError, KeyError, OSError, TypeError, IndexError, UnicodeError) as error:
        parser.exit(1, f"Demo build failed: {error}\n")


if __name__ == "__main__":
    main()

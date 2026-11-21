"""Export a verified guest recording as Markdown, JUnit XML and a digest manifest."""

import argparse
import hashlib
import html
import json
import os
import re
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

from check_trace import require, validate_trace


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def same_json(left, right):
    """Keep JSON types distinct: Python otherwise treats True == 1 == 1.0."""
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def verify_console(trace, data):
    evidence = data.get("evidence", {})
    name = evidence.get("console")
    require(isinstance(name, str) and name == Path(name).name,
            "Guest console must be a filename beside the trace")
    console = (trace.parent / name).resolve()
    require(console.parent == trace.parent.resolve(), "Guest console escapes artifact directory")
    console_bytes = console.read_bytes()
    checksum = hashlib.sha256(console_bytes).hexdigest()
    if data.get("suite_version") == 2 or "console_sha256" in evidence:
        require(evidence.get("console_sha256") == checksum, "Guest console SHA-256 mismatch")
    lines = console_bytes.decode("utf-8-sig").splitlines()
    observed = [json.loads(line[len("RECOVERY_EVENT "):])
                for line in lines if line.startswith("RECOVERY_EVENT ")]
    require(same_json(observed, data["events"]), "JSON events differ from the raw guest console")
    for marker in ("RECOVERY_LAB_EXIT=", "RECOVERY_RUN_EXIT="):
        require([line for line in lines if line.startswith(marker)] == [marker + "0"],
                f"Missing or unsuccessful guest exit marker: {marker}")
    for marker, field in (("RECOVERY_ENV ", "environment"), ("RECOVERY_CONFIG ", "config")):
        if field not in data:
            continue
        records = [json.loads(line[len(marker):]) for line in lines if line.startswith(marker)]
        require(len(records) == 1 and isinstance(records[0], dict), f"Missing guest {field}")
        require(same_json({key: data[field].get(key) for key in records[0]}, records[0]),
                f"Recorded {field} differs from guest console")
    for key in ("source_sha256", "binary_sha256", "boot_sha256", "disk_sha256"):
        require(re.fullmatch(r"[0-9a-f]{64}", evidence.get(key, "")) is not None,
                f"Missing or malformed recorded digest: {key}")
    if "source_snapshot" in evidence:
        source_name = evidence["source_snapshot"]
        require(isinstance(source_name, str) and source_name == Path(source_name).name,
                "Source snapshot must be a filename beside the trace")
        source = (trace.parent / source_name).resolve()
        require(source.parent == trace.parent.resolve(), "Source snapshot escapes artifact directory")
        require(digest(source) == evidence["source_sha256"], "Source snapshot SHA-256 mismatch")
    return console, checksum


def cell(value):
    text = html.escape(str(value), quote=False).replace("\r", " ").replace("\n", " ")
    return text.replace("|", "\\|").replace("`", "'").replace("[", "\\[").replace("]", "\\]")


def intervals(events):
    pairs = []
    pending = None
    for event in events:
        if event["event"] == "fault_injected":
            pending = {"generation": event["generation"], "fault_ms": event["t_ms"]}
        elif event["event"] == "hold" and pending is not None:
            pending["hold_ms"] = event["t_ms"]
            pending["reason"] = event["reason"]
        elif event["event"] in ("resumed", "locked_out") and pending is not None:
            pending["end_ms"] = event["t_ms"]
            pending["end"] = event["event"]
            pairs.append(pending)
            pending = None
    return pairs


def markdown(trace, data, console, checksum, trace_checksum):
    config = data.get("config", {})
    environment = data["environment"]
    rows = ["# QNX Recovery Lab — recorded run", "",
            f"Recorded: {cell(data.get('recorded_at', 'unknown'))}", "",
            "The independent event checks and raw guest-console correspondence passed. "
            "These checks establish internal consistency; they are not a cryptographic attestation of execution.", "",
            f"Guest: {cell(environment.get('os'))} {cell(environment.get('release', ''))}. "
            f"Runtime: {cell(environment.get('emulator', 'recorded QNX guest'))}.", "",
            f"Configuration: scenario={cell(config.get('scenario', 'legacy suite'))}, "
            f"fault_at={cell(config.get('fault_at', 8))}, "
            f"watchdog_ms={cell(config.get('watchdog_ms', 700))}, "
            f"restart_limit={cell(config.get('restart_limit', 2))}.", "",
            "| Scenario | Outcome | Restarts | Accepted | Rejected | Hold to resume (ms) |",
            "|---|---|---:|---:|---:|---:|"]
    for summary in data["scenarios"]:
        delay = summary.get("recovery_delay_ms")
        rows.append("| " + " | ".join(cell(value) for value in (
            summary["scenario"], summary.get("outcome", "passed"), summary["restarts"],
            summary["accepted"], summary["rejected"], "—" if delay is None else delay)) + " |")
    rows += ["", "## Observed fault intervals", "",
             "Times use the guest monotonic clock. Detection is measured from the worker's fault "
             "notice to the supervisor's hold event; it includes emulated scheduling and observation delay.", "",
             "| Scenario | Generation | Fault to hold (ms) | Hold to terminal transition (ms) | Transition |",
             "|---|---:|---:|---:|---|"]
    for summary in data["scenarios"]:
        events = [event for event in data["events"] if event["scenario"] == summary["scenario"]]
        for pair in intervals(events):
            rows.append("| " + " | ".join(cell(value) for value in (
                summary["scenario"], pair["generation"], pair["hold_ms"] - pair["fault_ms"],
                pair["end_ms"] - pair["hold_ms"], pair["end"])) + " |")
    rows += ["", "## Evidence", "", f"Trace: {cell(trace.name)}", "",
             f"Trace SHA-256: `{trace_checksum}`", "",
             f"Raw guest console: {cell(console.name)}", "",
             f"Console SHA-256: `{checksum}`", "",
             f"Events: {len(data['events'])}. Both guest exit markers report 0.", "",
             "Recorded build digests identify the files used by the runner. "
             "The exporter rehashes the source snapshot when present; it does not rehash the licensed SDK, executable or disk image.", "",
             "| Build component | Recorded SHA-256 |", "|---|---|"]
    for key in ("source_sha256", "binary_sha256", "boot_sha256", "disk_sha256"):
        rows.append(f"| {key} | `{data['evidence'][key]}` |")
    rows += ["", "## Limits", "",
             "Output is a simulated actuator value. Execution took place in QNX under QEMU software "
             "emulation. This run does not establish physical I/O behavior, hardware timing bounds, "
             "or production safety. A contained outcome means the expected restart budget was exhausted "
             "and the output was held at zero.", ""]
    return "\n".join(rows)


def junit(data):
    suite = ET.Element("testsuite", name="QNX Recovery Lab", tests=str(len(data["scenarios"])),
                       failures="0", errors="0", skipped="0")
    properties = ET.SubElement(suite, "properties")
    for key, value in data.get("config", {}).items():
        ET.SubElement(properties, "property", name=key, value=str(value))
    ET.SubElement(properties, "property", name="runtime", value="QNX guest under QEMU TCG")
    for summary in data["scenarios"]:
        events = [event for event in data["events"] if event["scenario"] == summary["scenario"]]
        case = ET.SubElement(suite, "testcase", classname="qnx.recovery", name=summary["scenario"],
                             time=f"{events[-1]['t_ms'] / 1000:.3f}")
        ET.SubElement(case, "system-out").text = json.dumps(summary, sort_keys=True)
    ET.indent(suite)
    return ET.tostring(suite, encoding="unicode", xml_declaration=True) + "\n"


def atomic_text(path, contents):
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=path.parent, delete=False) as stream:
            pending = Path(stream.name)
            stream.write(contents)
        os.replace(pending, path)
    finally:
        if pending is not None:
            pending.unlink(missing_ok=True)


def export(trace, output_prefix=None):
    trace = Path(trace).resolve()
    trace_bytes = trace.read_bytes()
    trace_checksum = hashlib.sha256(trace_bytes).hexdigest()
    data = json.loads(trace_bytes.decode("utf-8-sig"))
    validate_trace(data)
    console, checksum = verify_console(trace, data)
    prefix = Path(output_prefix).resolve() if output_prefix else trace.with_suffix("")
    destinations = [Path(str(prefix) + suffix) for suffix in (".md", ".junit.xml", ".manifest.json")]
    require(all(path not in (trace, console) for path in destinations), "Export would overwrite evidence")
    manifest = {
        "schema_version": 1,
        "trace": {"file": trace.name, "sha256": trace_checksum},
        "console": {"file": console.name, "sha256": checksum},
        "verification": {"event_invariants": "passed", "raw_console_correspondence": "passed"},
        "scenarios": [{"scenario": row["scenario"], "outcome": row.get("outcome", "passed")}
                      for row in data["scenarios"]],
    }
    if "source_snapshot" in data["evidence"]:
        manifest["source"] = {"file": data["evidence"]["source_snapshot"],
                              "sha256": data["evidence"]["source_sha256"]}
    for path, content in zip(destinations, (markdown(trace, data, console, checksum, trace_checksum), junit(data),
                                           json.dumps(manifest, indent=2) + "\n")):
        atomic_text(path, content)
    return destinations


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", nargs="?", type=Path, default=Path(__file__).parent / "artifacts/latest.json")
    parser.add_argument("--output-prefix", type=Path)
    args = parser.parse_args()
    try:
        for path in export(args.trace, args.output_prefix):
            print(path)
    except (ValueError, KeyError, OSError, TypeError, IndexError) as error:
        parser.exit(1, f"Report export failed: {error}\n")


if __name__ == "__main__":
    main()

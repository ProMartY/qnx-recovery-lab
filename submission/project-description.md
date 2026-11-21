# QNX Recovery Lab

## Elevator pitch

A fault-injection lab for QNX developers that makes worker recovery, message validation and zero-output lockout visible through recorded guest evidence.

## Category draft

Developer Tooling & Host Tools

## Inspiration

Restarting a failed process leaves several questions open. Which messages can still be trusted? When should output resume? What should happen when the replacement fails again?

Recovery Lab gives developers a small, inspectable example of those decisions. A separate supervisor owns a simulated actuator value. A worker proposes values, and the supervisor decides whether they can reach the output.

## What it does

The lab runs a healthy control and six fault scenarios in QNX 8.0. A worker exits with code 42, stops sending messages, proposes an out-of-range value, crashes repeatedly, repeats a sequence number, or sends an incorrect generation number.

The supervisor checks the sending process, protocol fields, generation, sequence, freshness and allowed value range. It holds the output at zero during validation and after a detected fault. A replacement worker must supply three fresh, valid proposals before output resumes. Once the restart budget is exhausted, the supervisor remains locked out at zero.

The generation test sends deliberately incorrect metadata from the active worker. It exercises generation validation within that controlled test case.

A browser viewer exposes individual events and measured intervals. A guided replay compares the same fault and watchdog settings with two permitted restarts and with none. JSON, Markdown, JUnit XML and digest manifests let developers inspect the evidence alongside the visual explanation.

## How it was built

The native C11 program uses QNX channels, synchronous message passing and timer pulses. The worker sends proposals with `MsgSend`, while the supervisor monitors the process and applies the output policy.

The Windows runner cross-compiles with `qcc` and GCC 12.2.0, builds a QNX x86-64 image with `mkqnximage`, and runs it under QEMU TCG. Python checks the event sequence, output state, rejection evidence, restart budget and summaries. The exporter also compares the trace with the raw guest console, successful exit markers and source snapshot hashes.

The main implementation is in `prototype/src/recovery_lab.c`. Evidence checks are in `prototype/check_trace.py` and `prototype/export_report.py`. The viewer, guided replay and portable offline page use HTML, CSS and JavaScript.

## What has been verified

The baseline recording contains 203 events from QNX 8.0.0. Healthy operation passes, five single-fault scenarios recover, and repeated crashes reach the expected zero-output lockout.

A second recording changes only the restart budget to zero. It contains 112 events. The healthy control passes, and all six fault scenarios reach the expected contained outcome. Both recordings use fault sequence 8 and a 700 ms watchdog. Their raw guest logs and source snapshots accompany the reports.

The 106.88-second demonstration video is a browser recording of this guided replay. It has 29 English caption cues and no audio. The underlying events came from native QNX guest executions, and the video presents those archived events through the UI.

## Challenges and lessons

An early implementation started the initial watchdog interval before process spawning had finished. The supervisor now refreshes its monotonic timestamp after a successful spawn. Both recordings used in the guided comparison were produced after that fix.

A separate run with a 300 ms watchdog failed in the healthy scenario after a 332 ms gap without an accepted proposal under QEMU. That failed trace remains archived. It shows why watchdog settings need to be evaluated in the environment where the application runs.

Recorded intervals describe these emulated runs. The output is simulated, and physical I/O, hardware timing bounds and production safety remain outside the measurements.

## What is next

The next technical step is to repeat the same scenarios on supported hardware and compare the recorded behavior. Further work can extend the fault cases while preserving reproducible traces and independent checks.

## Built with

QNX 8.0.0, C11, QNX IPC, qcc, GCC 12.2.0, QEMU, Windows, PowerShell, Python, HTML, CSS, JavaScript and Playwright.

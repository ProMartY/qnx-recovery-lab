# QNX Recovery Lab

## Elevator pitch

Inspect when a QNX worker is allowed to control an output after failure, with native fault injection, message validation and reproducible guest evidence.

## Category draft

Developer Tooling & Host Tools

## Inspiration

A developer building a process-based industrial controller on QNX needs to decide when a restarted worker's commands can reach the output again. Recovery Lab is a small, reproducible place to exercise and review that policy before adapting it to an application. The worker supplies proposals, and a separate supervisor owns the simulated actuator value.

## What it does

Seven scenarios exercise healthy operation, worker exit, stalled progress, an out-of-range value, repeated crashes, a duplicate sequence and an incorrect generation.

The supervisor validates the sender, message size, protocol fields, generation, sequence, freshness and value range. Output remains zero during fresh validation and after a detected fault. A replacement worker starts a new generation and needs three fresh, valid proposals before output resumes. Repeated failures exhaust the restart budget and end in zero-output lockout.

The sequence and generation tests send in-range values with deliberately incorrect fields from the active worker. They exercise message checks that a numeric range check alone would miss.

A detailed viewer connects the assessment to individual events, measured intervals and raw JSON. The guided workbench follows a message through the supervisor's decision to held or permitted output. A pausable tour follows 20 recorded decisions, and a self-contained offline page lets teammates inspect the pinned recordings.

## Why QNX

The supervisor and worker are native QNX processes. Worker termination leaves the supervisor running to observe the exit and manage replacement. QNX channels carry synchronous messages and timer pulses into its event loop, and `MsgReceive` supplies sender metadata for validation. Receipt acknowledgement and application acceptance are separate steps. These mechanisms directly implement the behavior under inspection.

## The technical contribution

A watchdog detects missing progress. Recovery Lab connects that detection with message validity, fresh validation and a bounded restart policy. A developer can trace each rejection, zero-output hold, replacement and resume or lockout to a guest event. Host checks verify those transitions independently of the summary's success flag.

## How it was built

A Windows runner builds the C11 program with `qcc`, GCC 12.2.0 and `mkqnximage`, then executes it in QNX 8.0.0 x86-64 under QEMU TCG.

Python checks event order, sequences, rejections, output and restart counts. The exporter compares events and environment/configuration with the raw console, checks exit markers and source hashes, and produces Markdown, JUnit XML and digest manifests.

The implementation is in `prototype/src/recovery_lab.c`, with checks in `prototype/check_trace.py` and `prototype/export_report.py`. The browser presentation uses HTML, CSS and JavaScript.

## What has been verified

The baseline recording has 203 guest events. Healthy operation passes, five single-fault scenarios recover, and repeated crashes reach the expected lockout after two restarts.

The 112-event comparison changes only the restart budget to zero. Healthy operation passes, and all six fault scenarios reach zero-output containment. Both recordings use fault sequence 8 and a 700 ms watchdog, with raw logs and matching source snapshots included.

The 158.32-second video starts with a new QNX guest execution observed live through its serial stream, then moves to the archived-event workbench. The new run, `run-20261124-000447-913.json`, contains 203 events and seven passing scenarios; both guest and host exit successfully. Its raw console, C snapshot and capture receipt accompany the video. The movie has 33 English caption cues and no audio.

The workbench also compares recorded response intervals. In the pinned baseline's out-of-range-command scenario, fault notice to hold is 11 ms and hold to validated resume is 280 ms. The zero-restart recording reaches lockout instead. These are observations of those emulated executions.

## Challenges and limits

An early watchdog interval included process-spawn overhead. The supervisor now refreshes its monotonic timestamp after successful spawning. Both pinned recordings were produced after that fix.

A separate 300 ms watchdog run failed in the healthy scenario after a 332 ms gap without an accepted proposal under QEMU. Its failed trace is retained.

Output is simulated. Recorded times describe those guest runs, and hardware timing, physical I/O and production safety require further validation. Hashes and matching logs establish internal consistency of locally produced evidence.

## What is next

Repeat the same scenarios on supported hardware, then evaluate the output policy with an application-specific I/O boundary while retaining the same event checks.

## Built with

QNX 8.0.0, C11, QNX IPC, qcc, GCC 12.2.0, QEMU, PowerShell, Python, HTML, CSS, JavaScript and Playwright.

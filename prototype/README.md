# QNX Recovery Lab

A local fault-injection lab for developers building process-based applications on QNX 8.0. It records how a supervisor detects a failed worker, holds a simulated output, starts a replacement process, and validates fresh messages before resuming output.

The prototype runs seven scenarios in the QNX guest: healthy operation, a worker exiting with code 42, a worker that stops sending messages, a worker proposing an out-of-range value, repeated crashes that exhaust the restart budget, a duplicate sequence number, and an incorrect process-generation number. The browser viewer replays the resulting guest trace.

## Run on this Windows host

The existing QNX SDK lives in `%USERPROFILE%\qnx800`. The verified local QEMU installation is in `../work/qemu-download/qemu`.

```powershell
.\prototype\run-lab.ps1
```

This compiles the C program with `qcc`, builds a QNX x86-64 image with `mkqnximage`, and boots QEMU in the background. It writes a guest console log and `prototype/artifacts/latest.json`, then stops the guest. The run uses a disposable disk copy and a virtual machine with networking disabled. Use `-SkipBuild` to rerun the existing image.

To test repeated crashes with one permitted restart, use the following command.

```powershell
.\prototype\run-lab.ps1 -Scenario crash_loop -FaultAt 6 -WatchdogMs 900 -RestartLimit 1
```

`-Scenario` accepts `all`, `healthy`, `crash`, `stall`, `invalid`, `crash_loop`, `replay`, or `wrong_generation`. `-FaultAt` selects a worker sequence number from 4 to 20, `-WatchdogMs` accepts 300 to 2000, and `-RestartLimit` accepts 0 to 3. A changed configuration requires a build. With `-SkipBuild`, pass the same configuration used to build the saved image. The runner checks the saved configuration and build hashes before booting. Only one run can use the VM directory at a time.

For example, run `replay` to send a duplicate of the preceding sequence number, or `wrong_generation` to send generation 0 from the generation-1 worker. These are deliberately malformed messages from the active worker; the generation test does not claim to recreate an old process sending after its replacement. Both tests must reject the message, hold output at zero, and validate the replacement worker before resuming.

To view the report, serve the `prototype` directory locally.

```powershell
python prototype/serve.py
```

Open `http://127.0.0.1:8764/viewer/`. The viewer also accepts an exported JSON trace through its file selector.

The server binds only to loopback and supports byte ranges for seeking the recorded demo video.

The **Next run configuration** section generates a PowerShell command from your selected scenario and limits. Copy that command into a terminal in the project directory to record the next guest run. The **Recorded assessment** describes the loaded recording and its actual configuration.

Select **Sequence replay** or **Wrong generation** and use the **Measured fault response** buttons to jump to the recorded fault notice, detection/hold, and recovery. The intervals are calculated from those events. In **Restart limit**, the last cycle ends in lockout instead of recovery. The timeline preserves event order when two events share the same millisecond.

## Guided demonstration

Open `http://127.0.0.1:8764/demo/` for the four-chapter demonstration, or open `demo/offline.html` directly without a server. It shows the supervisor, worker generation, actual proposed and accepted values, fresh validation, and restart budget. The **Baseline** and **No restarts** modes use two verified recordings with identical fault and watchdog settings. Playback moves through recorded events and does not start a live QNX guest.

The single-file offline snapshot and `artifacts/qnx-recovery-demo.zip` include pinned evidence. To regenerate the demo after verifying its inputs, run `python prototype/build_demo.py`. Add `--include-media` to include a previously captured browser screencast and captions. The ZIP contains no licensed SDK, QNX executables or VM images. [Presenter notes](DEMO.md) contain a short walkthrough and an English narration draft.

The served demo's **Inspect this event** link opens its immutable recording in the full viewer. Deep links accept a neighboring archived filename, scenario, and zero-based per-scenario event index, for example `viewer/?trace=run-20261122-011701-835.json&scenario=invalid&event=12`. Paths outside the artifact directory are ignored. Import and **Load latest run** remain available independently of the initial link.

## QNX implementation

The supervisor uses a QNX channel and a periodic timer pulse. A separate worker connects to the supervisor's channel and sends proposals through `MsgSend`. The supervisor acknowledges receipt, then validates the sender process, protocol fields, process generation, sequence number, freshness and output range before accepting output. It keeps output at zero during initial validation and recovery. A missing proposal deadline or failed process triggers a bounded restart, followed by three valid proposals before output resumes.

After spawning a worker, the supervisor refreshes its monotonic timestamp before starting that worker's initial watchdog interval. Process-spawn overhead therefore does not consume the initial interval; a clock failure still takes the owned child through cleanup.

When the restart budget is exhausted, the supervisor enters `locked_out` with output at zero. The `crash_loop` test passes when this expected containment is observed. A runtime error, unexpected intervention, or incorrect output still fails the test. The report distinguishes `healthy`, `recovered`, `contained`, and `failed` outcomes.

All output values describe a simulated actuator. The recorded durations use the QNX monotonic clock inside QEMU software emulation. They show the behavior of this run and do not establish hardware timing or a safety certification.

## Evidence

Each completed guest run saves an immutable `artifacts/run-<timestamp>.json`, the matching raw guest console log, and a source-code snapshot. After the guest exit marker, the runner stops QEMU and rereads the closed console file before hashing it. The report includes guest operating-system information, actual run configuration, event trace, scenario outcomes, and source, executable, boot-image, disk and console hashes.

`artifacts/latest.json` is the last **verified** recording. It is published only after independent event checks and report export succeed. A failed attempt keeps the preceding verified recording and its reports; its error is written to `artifacts/latest-attempt.json`. Completed failed guest traces remain archived and can be imported manually. A failed build or incomplete guest run may have only logs and attempt status.

Successful runs also produce Markdown, JUnit XML and a digest manifest beside the JSON recording. Convenient aliases are `artifacts/latest.md`, `artifacts/latest.junit.xml` and `artifacts/latest.manifest.json`. To regenerate them independently, use:

```powershell
python prototype/export_report.py
```

The exporter checks the event invariants, exact correspondence to raw guest events, guest ENV/CONFIG, successful exit markers, console digest and source snapshot digest before writing. It can also export an archived trace by path. These are consistency checks of local evidence, not an execution attestation. The licensed executable and disk are not included in the exported reports. A JUnit pass with `contained` means the expected zero-output lockout was observed.

The original four scenarios, the extended five-scenario suite and the seven-scenario suite passed on QNX 8.0.0. After the spawn timestamp fix, the full suite passed with the default configuration and again with only the restart budget changed to zero. The demo pins those two recordings: 203 and 112 events. Earlier guest runs verified one permitted restart and a zero-budget run with fault_at=4/watchdog_ms=300. A later 300 ms stress run failed in the healthy scenario after a 332 ms gap without an accepted proposal under QEMU; its failed trace remains archived. These observations do not establish a reliable lower watchdog bound on hardware or under host load.

To independently check output containment, message sequences, fault detection and recovery from the recorded events, run `python prototype/check_trace.py` from the project root. You can pass an archived JSON path to check an earlier run. New seven-scenario reports use `suite_version: 2`; archived four- and five-scenario reports remain supported.

Run `python -m unittest discover -s prototype/tests -v` for checker and exporter regression tests. They include corrupted sequences, false success summaries, mismatched generations, restart-budget violations, changed console/source files and unsuccessful exit markers. Synthetic fixtures in those tests do not stand in for guest execution.

The target image and QNX SDK contain licensed vendor software. They stay in the local work directory. The source and viewer are in `prototype`.

## Project status

Local prototype work began on November 18, 2026 following the user's instruction to proceed. The public hackathon overview describes the Developer Tooling & Host Tools category. The full event rules, including the permitted scope of AI assistance and any disclosure requirements, remain to be confirmed before preparing a submission.

## References

- [QNX hackathon requirements and judging criteria](https://qnx.devpost.com/)
- [QNX ChannelCreate](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/channelcreate.html)
- [QNX ConnectAttach](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/c/connectattach.html)
- [QNX MsgReceive](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/m/msgreceive.html)
- [QNX image builder](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.utilities/topic/m/mkqnximage.html)


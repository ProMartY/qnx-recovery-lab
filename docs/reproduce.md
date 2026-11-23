# Reproduce the project

Run the commands below from the repository root. A Python-only path checks the archived evidence and opens its browser replay. A native path builds and executes the C program in a QNX guest.

## Inspect and verify with Python 3.12

Install Python 3.12 and use a current browser. The Python tools use the standard library.

```powershell
python --version
python -m unittest discover -s prototype/tests -v
python prototype/check_trace.py prototype/artifacts/run-20261122-011701-835.json
python prototype/check_trace.py prototype/artifacts/run-20261122-011927-411.json
```

The two pinned traces contain seven scenarios each, with 203 baseline events and 112 zero-restart events. The event checker verifies the archived event sequences. To verify their raw console/source correspondence and regenerate the human-readable and JUnit reports in a scratch directory, run the following commands.

```powershell
python prototype/export_report.py prototype/artifacts/run-20261122-011701-835.json --output-prefix work/reports/baseline
python prototype/export_report.py prototype/artifacts/run-20261122-011927-411.json --output-prefix work/reports/no-restarts
```

The tests require the retained archive fixtures in `prototype/tests/fixtures`, including historical four- and five-scenario JSON traces. Exporter tests also read `prototype/artifacts/latest.json` and the console/source filenames referenced by that recording. The demo tests read the pinned pair in `prototype/artifacts` and legacy comparison fixtures. Keep these evidence files with the source when preparing a clone or source archive.

Start the loopback-only browser server.

```powershell
python prototype/serve.py --port 8764
```

Open the following local pages.

- [Guided demonstration](http://127.0.0.1:8764/demo/) presents four chapters with baseline and zero-restart recordings.
- [Detailed trace viewer](http://127.0.0.1:8764/viewer/) loads the latest verified recording and accepts imported JSON files.
- [Recorded video player](http://127.0.0.1:8764/demo/video.html) plays the supplied browser screencast when its media files are present.

Stop the server with Ctrl+C. `--port` can select another available port. The optional video recorder expects port 8764.

You can also open `prototype/demo/offline.html` directly in the browser. It contains the pinned JSON evidence and UI assets. Its playback uses the saved recording. The full viewer's archived-event links use the surrounding served repository.

## Rebuild the verified demo snapshot

```powershell
python prototype/build_demo.py
```

The builder verifies the reference trace digests, event invariants, console correspondence, exit markers, and source snapshots before writing generated files. Its outputs include `prototype/demo/manifest.json`, the two files under `prototype/demo/data/`, `prototype/demo/offline.html`, and `prototype/artifacts/qnx-recovery-demo.zip`.

The default pins are fixed archive filenames. They remain stable when `latest.json` advances. The paired recordings both use fault sequence 8 and a 700 ms watchdog, with restart limits 2 and 0 respectively. To package new verified recordings, pass `--baseline` and `--no-restarts` with the new immutable JSON paths. Each input needs its neighboring raw guest log and source snapshot, all seven scenarios, and matching fault/watchdog settings.

Add `--include-media` after successfully recording or supplying the supported local video/caption files.

```powershell
python prototype/build_demo.py --include-media
```

The portable demo contains source and recorded evidence. Obtain the licensed QNX SDK, QNX runtime image components, and local emulator tools separately for a new native execution.

## Execute a new QNX guest run on Windows

The recorded configuration used Windows, PowerShell 7, QNX SDP 8.0 with GCC 12.2.0, QEMU 11.1 with TCG, and Python 3.12. The guest reported QNX 8.0.0 on `x86pc`. This is the configuration exercised by the saved evidence.

Prepare the following local prerequisites.

- A licensed and activated QNX SDP 8.0 installation containing `qnxsdp-env.bat`, `qcc`, `mkqnximage`, and the target components required by the image builder.
- A Windows x86-64 QEMU installation with `qemu-system-x86_64.exe`, its DLL dependencies, and its `share` firmware directory.
- PowerShell 7 and Python 3.12 available from the terminal.
- Space for generated VM images and an ordinary writable local work directory.

The runner accepts SDK, emulator, and work-directory paths. Replace the generic example paths with your installations.

```powershell
$labPaths = @{
    SdkRoot = 'C:\QNX SDP\qnx800'
    QemuRoot = 'C:\Program Files\qemu'
    WorkRoot = '.\work\qnx-recovery-vm'
}

.\prototype\run-lab.ps1 @labPaths -Scenario all -FaultAt 8 -WatchdogMs 700 -RestartLimit 2
```

The first run creates its work directory, compiles the source, and generates the QNX boot and disk images. The runner loads the SDK's batch environment inside its build commands. Its defaults use the user's `qnx800` SDK directory and the repository-local `work/qemu-download/qemu` and `work/qnx-recovery-vm` directories. Passing the paths explicitly makes a fresh clone independent of those defaults.

The cross-compiler invocation uses these flags.

```text
-Vgcc_ntox86_64 -std=c11 -D_QNX_SOURCE -Wall -Wextra -Werror -O2
```

The generated VM boots with one virtual CPU, 512 MiB RAM, TCG software emulation, a disposable IDE disk copy, serial capture, and networking disabled. It uses a headless emulator process. The runner waits for guest exit evidence, stops QEMU, closes the console capture, validates the trace, and exports the reports. Completion requires the guest scenarios and host evidence checks to pass.

To run the same seven scenarios with no restart budget, use the same paths and change the limit.

```powershell
.\prototype\run-lab.ps1 @labPaths -Scenario all -FaultAt 8 -WatchdogMs 700 -RestartLimit 0
```

For an individual malformed-message scenario, use one of these commands.

```powershell
.\prototype\run-lab.ps1 @labPaths -Scenario replay -FaultAt 8 -WatchdogMs 700 -RestartLimit 2
.\prototype\run-lab.ps1 @labPaths -Scenario wrong_generation -FaultAt 8 -WatchdogMs 700 -RestartLimit 2
```

| Parameter | Accepted values | Default |
| --- | --- | --- |
| `Scenario` | `all`, `healthy`, `crash`, `stall`, `invalid`, `crash_loop`, `replay`, `wrong_generation` | `all` |
| `FaultAt` | Integer 4–20 | 8 |
| `WatchdogMs` | Integer 300–2000 | 700 |
| `RestartLimit` | Integer 0–3 | 2 |
| `TimeoutSeconds` | Integer 20–180 for the host's overall wait | 90 |
| `SdkRoot`, `QemuRoot`, `WorkRoot` | Local installation/work paths | As described above |

`-SkipBuild` reuses a saved image with the same configuration. Pass the same scenario and limits as its original build. The runner checks saved component hashes and configuration before booting. After editing the C source, run with the build stage enabled to incorporate the changes.

## Read the run result

A verified run archives `run-<timestamp>.json` with its matching `guest-<timestamp>.log` and `source-<timestamp>.c`. Markdown, JUnit XML, and digest manifests share that run's prefix. The latest verified aliases are `latest.json`, `latest.md`, `latest.junit.xml`, and `latest.manifest.json`.

`latest-attempt.json` records whether the most recent attempt is running, passed, or failed. A failed build, guest execution, check, or export retains the preceding verified recording. A completed failed guest run has an immutable JSON archive for inspection. Read the status and the matching console when diagnosing an unsuccessful attempt.

Expected containment passes when the configured restart budget is exhausted with output held at zero. The summary distinguishes `healthy`, `recovered`, `contained`, and `failed`. The viewer shows the measured hold-to-resume interval when the recording contains a recovery.

The parameter range permits experiments with a 300 ms watchdog. An archived stress run at that setting, `run-20261122-011802-242.json`, failed in the healthy scenario after 332 ms without an accepted proposal. It records an unexpected watchdog fault under emulation. A new run's timing and outcome depend on host load and emulated scheduling. Preserve and inspect an unsuccessful trace instead of treating its result as a passing recording.

## Optional browser video recording

The recorder supports an archived UI replay and a new native QNX run followed by that replay. Both use Node.js, Playwright 1.65.1, a separately installed Chrome available to Playwright's `chrome` channel, and Playwright's FFmpeg build 1013. These browser tools and their local caches are outside the source repository.

Install the repository's locked development dependencies and the FFmpeg helper into the local browser cache.

```powershell
npm ci
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) 'work/browser-cache'
npx playwright install ffmpeg
```

Keep the Python server running on port 8764 in another terminal. Run the recorder from the repository root. The UI-only mode drives the existing pinned recordings.

```powershell
node prototype/tools/record-demo.cjs
```

For native-plus-replay mode, first build the normal `all`/8/700/2 image using the runner's default SDK and emulator locations. Rebuild this configuration after running any of the other native examples.

```powershell
.\prototype\run-lab.ps1 -Scenario all -FaultAt 8 -WatchdogMs 700 -RestartLimit 2
```

This capture entry point uses the runner's default SDK at `%USERPROFILE%\qnx800` and QEMU at `work/qemu-download/qemu`. It forwards the work-directory setting to the runner. The standalone runner's custom `SdkRoot` and `QemuRoot` parameters are separate from this recorder entry point.

The capture defaults to `work/qnx-recovery-vm`. If the normal image was built with another `WorkRoot`, set `QNX_CAPTURE_WORK_ROOT` to that directory's absolute path before invoking the recorder. For the `$labPaths.WorkRoot` prepared above, use the following assignment.

```powershell
$env:QNX_CAPTURE_WORK_ROOT = (Resolve-Path $labPaths.WorkRoot).Path
```

Start native-plus-replay capture with the following command.

```powershell
node prototype/tools/record-demo.cjs --native
```

This mode prepares a read-only observer on localhost before starting a new owned QNX guest run through the runner's `-SkipBuild` path. That path checks the saved source, configuration and build hashes. The observer displays the new run's serial output as it arrives. The same continuous browser capture then moves to the archived UI replay.

Both modes use an isolated headless Chrome context at 1440 × 1000, drive the chapter and event controls, and check displayed output against the selected archived events. They produce `demo.webm`, English `demo.vtt` captions and an event-selection timeline. Guest timestamps remain visible independently of browser presentation pace.

The completed candidate movie is opened in Chrome and its actual media duration must be below three minutes before replacing the published local clip. Time spent closing or encoding the recording is separate from the movie's measured duration. A successful native capture also writes `prototype/artifacts/demo-native-capture.json`, binding the fresh run, console and source digests, and the observer/recorder source hashes, to the movie.

After a successful recording, rebuild the portable package.

```powershell
python prototype/build_demo.py --include-media
```

When deliberately switching from native-plus-replay to UI-only capture, complete the UI-only recording successfully first. Move the previous `prototype/artifacts/demo-native-capture.json` out of the artifacts directory and retain it with the original clip's local history before rebuilding. Its strict movie binding belongs to the original capture. Preserve the original raw guest logs, JSON recording and source snapshot.

The recorder requires pinned demo data, a working local server and the expected Chrome/FFmpeg tools. Native-plus-replay mode also requires the prepared native image and runner prerequisites. If a dependency is unavailable, the existing offline replay and Python evidence checks remain usable. See the [architecture](architecture.md) for the native behavior and evidence boundaries.

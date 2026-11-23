# QNX Recovery Lab recorded demo

Open offline.html directly to play the self-contained snapshot. For the served version, run `python -m http.server 8000` from this directory and open http://localhost:8000/.

The interface replays two recorded QNX 8.0 guest runs under QEMU TCG on Windows. Playback controls move through recorded events. Output is a simulated actuator value.

| Recording | Source trace | Events | Restart limit |
|---|---|---:|---:|
| baseline | run-20261122-011701-835.json | 203 | 2 |
| no_restarts | run-20261122-011927-411.json | 112 | 0 |

The JSON traces are byte-for-byte copies of the pinned source files. Each data/evidence directory contains its original guest console, C source snapshot and a report generated after validation. manifest.json records their SHA-256 digests and the checks that passed.

The builder checks event invariants, exact raw-console correspondence, both successful guest exit markers, trace digests and source-snapshot digests before publishing. Digests and matching records establish internal consistency. They provide no independent attestation of execution, hardware timing, physical I/O behavior or production safety.

A separate workspace recording, run-20261122-011802-242.json, used a 300 ms watchdog and reported an unexpected healthy-scenario timeout after 332 ms without an accepted proposal during QEMU software emulation. That failed recording remains in the workspace history. This package selects the two verified recordings listed above for policy comparison.

The package contains the demo interface, recordings, text evidence and any explicitly included browser screencast. Licensed SDK files, QNX executables and boot/disk images remain outside the package. Binary and image digests in the traces identify the recorded build inputs.

The full-workspace viewer link requires the surrounding prototype directory when served. The portable snapshot plays independently.

[Watch the captioned browser screencast](./video.html). Open video.html directly from this directory. The movie starts with a newly executed QNX guest run observed live, then switches to the archived-event workbench. data/native includes the direct segment's immutable trace, raw console, source snapshot and capture receipt. Media file digests and sizes are listed in manifest.json.

From the full workspace, run `python prototype/serve.py` and use the printed server address. That server supports byte-range requests for video seeking. A basic HTTP server can play the recording progressively. Seeking requires byte-range support or a fully buffered recording.

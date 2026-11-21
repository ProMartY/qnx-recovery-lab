# QNX Recovery Lab — recorded run

Recorded: 2026-11-21T23:46:39.2843213Z

The independent event checks and raw guest-console correspondence passed. These checks establish internal consistency; they are not a cryptographic attestation of execution.

Guest: QNX 8.0.0. Runtime: QEMU TCG on Windows.

Configuration: scenario=all, fault_at=8, watchdog_ms=700, restart_limit=2.

| Scenario | Outcome | Restarts | Accepted | Rejected | Hold to resume (ms) |
|---|---|---:|---:|---:|---:|
| healthy | healthy | 0 | 12 | 0 | — |
| crash | recovered | 1 | 18 | 0 | 232 |
| stall | recovered | 1 | 18 | 0 | 270 |
| invalid | recovered | 1 | 18 | 1 | 241 |
| crash_loop | contained | 2 | 21 | 0 | — |
| replay | recovered | 1 | 18 | 1 | 246 |
| wrong_generation | recovered | 1 | 18 | 1 | 241 |

## Observed fault intervals

Times use the guest monotonic clock. Detection is measured from the worker's fault notice to the supervisor's hold event; it includes emulated scheduling and observation delay.

| Scenario | Generation | Fault to hold (ms) | Hold to terminal transition (ms) | Transition |
|---|---:|---:|---:|---|
| crash | 1 | 30 | 232 | resumed |
| stall | 1 | 628 | 270 | resumed |
| invalid | 1 | 6 | 241 | resumed |
| crash_loop | 1 | 31 | 229 | resumed |
| crash_loop | 2 | 13 | 229 | resumed |
| crash_loop | 3 | 10 | 0 | locked_out |
| replay | 1 | 5 | 246 | resumed |
| wrong_generation | 1 | 7 | 241 | resumed |

## Evidence

Trace: run-20261122-014546-687.json

Trace SHA-256: `e3cd993a160e73dfc2783a63d6dd2e59eebe53700d3cb266063dd3f3c7d1928f`

Raw guest console: guest-20261122-014546-687.log

Console SHA-256: `70413b5c48edb7361f49695c46b3ef774a5a03ad2a7a064d1c319a54ac013d59`

Events: 203. Both guest exit markers report 0.

Recorded build digests identify the files used by the runner. The exporter rehashes the source snapshot when present; it does not rehash the licensed SDK, executable or disk image.

| Build component | Recorded SHA-256 |
|---|---|
| source_sha256 | `9c32b86ebe50ef0edf883f122cf5ad12ddad5d14744974d80d49da6a0005216d` |
| binary_sha256 | `99be8764781cbc04a602e3fcc9eab024e789e789d1a2b6ae18cb1b7138172859` |
| boot_sha256 | `fb077f707fb0076447c32cd1a4d77562bf8e93884b429cc6ec27e20581a16602` |
| disk_sha256 | `1c1cf3d0a566ee7dcfae26a794e58de74d2b8f10e83ee5afe33d2110514e904f` |

## Limits

Output is a simulated actuator value. Execution took place in QNX under QEMU software emulation. This run does not establish physical I/O behavior, hardware timing bounds, or production safety. A contained outcome means the expected restart budget was exhausted and the output was held at zero.

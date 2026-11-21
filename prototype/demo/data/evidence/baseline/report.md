# QNX Recovery Lab — recorded run

Recorded: 2026-11-21T23:17:52.0261441Z

The independent event checks and raw guest-console correspondence passed. These checks establish internal consistency; they are not a cryptographic attestation of execution.

Guest: QNX 8.0.0. Runtime: QEMU TCG on Windows.

Configuration: scenario=all, fault_at=8, watchdog_ms=700, restart_limit=2.

| Scenario | Outcome | Restarts | Accepted | Rejected | Hold to resume (ms) |
|---|---|---:|---:|---:|---:|
| healthy | healthy | 0 | 12 | 0 | — |
| crash | recovered | 1 | 18 | 0 | 248 |
| stall | recovered | 1 | 18 | 0 | 284 |
| invalid | recovered | 1 | 18 | 1 | 280 |
| crash_loop | contained | 2 | 21 | 0 | — |
| replay | recovered | 1 | 18 | 1 | 287 |
| wrong_generation | recovered | 1 | 18 | 1 | 305 |

## Observed fault intervals

Times use the guest monotonic clock. Detection is measured from the worker's fault notice to the supervisor's hold event; it includes emulated scheduling and observation delay.

| Scenario | Generation | Fault to hold (ms) | Hold to terminal transition (ms) | Transition |
|---|---:|---:|---:|---|
| crash | 1 | 31 | 248 | resumed |
| stall | 1 | 625 | 284 | resumed |
| invalid | 1 | 11 | 280 | resumed |
| crash_loop | 1 | 46 | 299 | resumed |
| crash_loop | 2 | 12 | 254 | resumed |
| crash_loop | 3 | 45 | 0 | locked_out |
| replay | 1 | 8 | 287 | resumed |
| wrong_generation | 1 | 7 | 305 | resumed |

## Evidence

Trace: run-20261122-011701-835.json

Trace SHA-256: `b4bc6afa8040a1a8c365534439de0e8dda98d36d93cc6e3bfbcefb539196aac4`

Raw guest console: guest-20261122-011701-835.log

Console SHA-256: `4b12a29fc01fa67101be36a2301aa58701d6e44d9db7fd425f945cbd120e0907`

Events: 203. Both guest exit markers report 0.

Recorded build digests identify the files used by the runner. The exporter rehashes the source snapshot when present; it does not rehash the licensed SDK, executable or disk image.

| Build component | Recorded SHA-256 |
|---|---|
| source_sha256 | `9c32b86ebe50ef0edf883f122cf5ad12ddad5d14744974d80d49da6a0005216d` |
| binary_sha256 | `99be8764781cbc04a602e3fcc9eab024e789e789d1a2b6ae18cb1b7138172859` |
| boot_sha256 | `5e8dac9836ad9accbe426801aed8cb73c94629b883015966eb1533c3574bbcce` |
| disk_sha256 | `d0031d4ae4c86a62202fb994766b7ffe4a68505adba60c2a89f27527fd0c63e2` |

## Limits

Output is a simulated actuator value. Execution took place in QNX under QEMU software emulation. This run does not establish physical I/O behavior, hardware timing bounds, or production safety. A contained outcome means the expected restart budget was exhausted and the output was held at zero.

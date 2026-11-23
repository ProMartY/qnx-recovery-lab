# QNX Recovery Lab — recorded run

Recorded: 2026-11-23T22:05:23.4125279Z

The independent event checks and raw guest-console correspondence passed. These checks establish internal consistency; they are not a cryptographic attestation of execution.

Guest: QNX 8.0.0. Runtime: QEMU TCG on Windows.

Configuration: scenario=all, fault_at=8, watchdog_ms=700, restart_limit=2.

| Scenario | Outcome | Restarts | Accepted | Rejected | Hold to resume (ms) |
|---|---|---:|---:|---:|---:|
| healthy | healthy | 0 | 12 | 0 | — |
| crash | recovered | 1 | 18 | 0 | 236 |
| stall | recovered | 1 | 18 | 0 | 278 |
| invalid | recovered | 1 | 18 | 1 | 245 |
| crash_loop | contained | 2 | 21 | 0 | — |
| replay | recovered | 1 | 18 | 1 | 290 |
| wrong_generation | recovered | 1 | 18 | 1 | 238 |

## Observed fault intervals

Times use the guest monotonic clock. Detection is measured from the worker's fault notice to the supervisor's hold event; it includes emulated scheduling and observation delay.

| Scenario | Generation | Fault to hold (ms) | Hold to terminal transition (ms) | Transition |
|---|---:|---:|---:|---|
| crash | 1 | 28 | 236 | resumed |
| stall | 1 | 625 | 278 | resumed |
| invalid | 1 | 6 | 245 | resumed |
| crash_loop | 1 | 21 | 236 | resumed |
| crash_loop | 2 | 8 | 237 | resumed |
| crash_loop | 3 | 49 | 0 | locked_out |
| replay | 1 | 7 | 290 | resumed |
| wrong_generation | 1 | 7 | 238 | resumed |

## Evidence

Trace: run-20261124-000447-913.json

Trace SHA-256: `5a2f166056ac4e3c480e9a932786fa17f00eaeda6e03d92539be07cc616f3179`

Raw guest console: guest-20261124-000447-913.log

Console SHA-256: `70b13cc35e735678f08b794a6d74b1e2a3fc0b9518350df09aacef9baa670343`

Events: 203. Both guest exit markers report 0.

Recorded build digests identify the files used by the runner. The exporter rehashes the source snapshot when present; it does not rehash the licensed SDK, executable or disk image.

| Build component | Recorded SHA-256 |
|---|---|
| source_sha256 | `9c32b86ebe50ef0edf883f122cf5ad12ddad5d14744974d80d49da6a0005216d` |
| binary_sha256 | `99be8764781cbc04a602e3fcc9eab024e789e789d1a2b6ae18cb1b7138172859` |
| boot_sha256 | `c8d810b4c3a25704c29c7e3e3ba3fe1dfbbedece40c87b922036993c98aa7cc2` |
| disk_sha256 | `2b6917d2ec3f2852f0b0e07269b29d3a2b5872340a044969695e48c7f50fb900` |

## Limits

Output is a simulated actuator value. Execution took place in QNX under QEMU software emulation. This run does not establish physical I/O behavior, hardware timing bounds, or production safety. A contained outcome means the expected restart budget was exhausted and the output was held at zero.

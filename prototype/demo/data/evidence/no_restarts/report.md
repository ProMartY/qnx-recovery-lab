# QNX Recovery Lab — recorded run

Recorded: 2026-11-21T23:20:12.8528178Z

The independent event checks and raw guest-console correspondence passed. These checks establish internal consistency; they are not a cryptographic attestation of execution.

Guest: QNX 8.0.0. Runtime: QEMU TCG on Windows.

Configuration: scenario=all, fault_at=8, watchdog_ms=700, restart_limit=0.

| Scenario | Outcome | Restarts | Accepted | Rejected | Hold to resume (ms) |
|---|---|---:|---:|---:|---:|
| healthy | healthy | 0 | 12 | 0 | — |
| crash | contained | 0 | 7 | 0 | — |
| stall | contained | 0 | 7 | 0 | — |
| invalid | contained | 0 | 7 | 1 | — |
| crash_loop | contained | 0 | 7 | 0 | — |
| replay | contained | 0 | 7 | 1 | — |
| wrong_generation | contained | 0 | 7 | 1 | — |

## Observed fault intervals

Times use the guest monotonic clock. Detection is measured from the worker's fault notice to the supervisor's hold event; it includes emulated scheduling and observation delay.

| Scenario | Generation | Fault to hold (ms) | Hold to terminal transition (ms) | Transition |
|---|---:|---:|---:|---|
| crash | 1 | 33 | 0 | locked_out |
| stall | 1 | 609 | 0 | locked_out |
| invalid | 1 | 7 | 0 | locked_out |
| crash_loop | 1 | 23 | 0 | locked_out |
| replay | 1 | 11 | 0 | locked_out |
| wrong_generation | 1 | 20 | 0 | locked_out |

## Evidence

Trace: run-20261122-011927-411.json

Trace SHA-256: `199e6d0dcf858340e329f6bd53ac1c5544001118a24dd76fffee91850706f4a1`

Raw guest console: guest-20261122-011927-411.log

Console SHA-256: `632e6a4787ed743edf862defe3390a05cb2e34dac98e18824ec3c4a32ef7dbb9`

Events: 112. Both guest exit markers report 0.

Recorded build digests identify the files used by the runner. The exporter rehashes the source snapshot when present; it does not rehash the licensed SDK, executable or disk image.

| Build component | Recorded SHA-256 |
|---|---|
| source_sha256 | `9c32b86ebe50ef0edf883f122cf5ad12ddad5d14744974d80d49da6a0005216d` |
| binary_sha256 | `99be8764781cbc04a602e3fcc9eab024e789e789d1a2b6ae18cb1b7138172859` |
| boot_sha256 | `ffd692e8b1128cfab56fe358f05bd44c7b3c77428257fc70a5645dafaa239845` |
| disk_sha256 | `4b2b562753a27e1bc1d40d62d462406e58a340d45835df3e233689cfc4f830a7` |

## Limits

Output is a simulated actuator value. Execution took place in QNX under QEMU software emulation. This run does not establish physical I/O behavior, hardware timing bounds, or production safety. A contained outcome means the expected restart budget was exhausted and the output was held at zero.

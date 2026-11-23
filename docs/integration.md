# Integration boundary

The current integration boundary is the C source. Recovery Lab spawns its built-in worker from the same `/proc/boot/recovery-lab` executable. Replacing that worker requires source changes, a rebuild, and a new QNX image. The published CLI selects the supplied scenarios, injection sequence, watchdog, and restart budget.

This document describes the current implementation as a reference for a developer adaptation. The internal message layout and worker arguments are not a published, versioned integration API. See [architecture](architecture.md) for the executed model and [reproduction](reproduce.md) for the build and evidence workflow.

## Current process boundary

The supervisor owns the QNX channel, worker PID, generation, watchdog, restart budget, and accepted numeric output. The worker calculates proposals and sends them over native QNX IPC. The output is an integer in supervisor memory, with zero used as the experiment's hold value.

In [recovery_lab.c](../prototype/src/recovery_lab.c), start with these functions.

| Function or type | Current responsibility |
| --- | --- |
| `worker_main` | Connect, calculate proposals, inject the selected fault, and send messages |
| `spawn_worker` | Spawn the same executable and pass the parent PID, channel ID, and new generation |
| `struct proposal` | Define the internal native message layout |
| `message_error` | Validate sender metadata, protocol, generation, sequence, range, and freshness |
| `on_message` | Record acceptance or rejection and update supervisor-owned output |
| `hold_and_restart`, `on_tick`, `cleanup` | Hold output, detect lifecycle faults, enforce the budget, and release owned resources |

The supervisor supplies this internal invocation.

```text
/proc/boot/recovery-lab --worker <parent-pid> <chid> <generation> <scenario> <fault-at> <watchdog-ms>
```

The worker calls `ConnectAttach(0, parent_pid, chid, _NTO_SIDE_CHANNEL, 0)`. An independently launched process does not become the owned worker merely by connecting to the channel. Sender validation requires the PID recorded by the supervisor's successful `posix_spawn`.

## Current proposal contract

The message is `struct proposal` from the C file, sent with `sizeof(struct proposal)` on this QNX target ABI. It contains six 32-bit fields. It is a native structure rather than a portable serialized wire format.

| Field | Required value for a normal proposal |
| --- | --- |
| `magic` | `0x524c4142` |
| `version` | `1` |
| `kind` | `PROPOSAL`, currently `1` |
| `generation` | The generation supplied by the supervisor |
| `seq` | The next sequence, beginning at `1` in each generation |
| `value` | An integer from `20` through `60` |

The supervisor checks both received and original message lengths, the sender PID, and the fields above. Proposal freshness uses its monotonic time since the previous accepted proposal, with an initial grace interval established after a successful spawn. The supplied worker waits approximately 100 ms between proposals.

Three fresh accepted proposals are required in every generation before output is released. The first two keep output at zero. A replacement starts again at sequence one and must complete the same validation.

`MsgReply(rcvid, 0, NULL, 0)` acknowledges receipt before lifecycle actions and validation. A successful `MsgSend` therefore means the synchronous exchange completed. Output acceptance is established by the supervisor's validation and recorded events. The worker uses `TimerTimeout` to bound send/reply waits, immediately followed by `MsgSend` as the timed kernel operation.

`FAULT_NOTICE`, currently kind `2`, belongs to the supplied fault-injection harness. Its expected sequence is the configured injection point and its value is zero. It announces the intentional fault without advancing the accepted proposal sequence. Unexpected faults hold output and fail the current experiment. General recovery from arbitrary application failures requires a deliberate change to that policy and its tests.

## Adapting an application

1. Begin with a narrow computation inside `worker_main`, preserving supervisor ownership of the output and the validated message fields. Keep the supplied fault cases available as regression experiments.
2. Define application-specific ranges, hold behavior, startup validation, deadlines, and recovery criteria. The current program has a 20-second guest-time limit per scenario and demonstration-specific success conditions, including 12 healthy proposals or eight further valid proposals after recovery.
3. If a separate executable is needed, change the spawn path and argument handling and include the executable and its runtime dependencies in the image snippets used by [run-lab.ps1](../prototype/run-lab.ps1). The runner's application snippet currently adds the supplied Recovery Lab executable.
4. Update the checker and expected outcomes when changing the protocol or policy. Retain checks for malformed messages, wrong sender/generation/sequence, late proposals, zero-output holds, bounded restarts, fresh validation, and cleanup.
5. Rebuild without `-SkipBuild`, execute on QNX, and preserve the new run's source snapshot, serial console, configuration, and digests. Run [check_trace.py](../prototype/check_trace.py) and [export_report.py](../prototype/export_report.py) against that run. The supplied archived recordings describe the supplied worker.

Connecting physical I/O or another application requires an application-specific output adapter and validation on the intended target. This repository currently exercises simulated output under QEMU and does not implement a physical actuator integration.

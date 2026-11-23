# Recovery Lab presentation draft

Prepared 23 November 2026. The current public overview evaluates the working QNX implementation, the product experience, a specific problem and impact, and creative use backed by understanding of the problem. This draft leads with the developer's output-recovery decision and then shows the evidence. [Official overview](https://qnx.devpost.com/)

## Spoken pitch, approximately 45 seconds

Recovery Lab helps QNX developers inspect the moment a replacement worker is allowed to control an output.

A native supervisor owns a simulated value. Workers send proposals through QNX IPC. The supervisor checks the sender, sequence, generation, range and freshness. After a fault, output holds at zero. A replacement needs three fresh proposals, and repeated failures exhaust a fixed restart budget.

Seven scenarios have run in QNX 8 under QEMU. The interface explains each recorded decision, and independent checks compare the trace with its raw guest log.

That makes the recovery policy inspectable, from the rejected message to zero-output lockout.

## Three judge takeaways

1. **QNX has a concrete role.** Separate native processes, synchronous IPC, sender metadata and timer pulses support the implemented supervisor and worker behavior.
2. **Output permission is explicit.** Fresh validation and a finite restart budget connect message checks to held, resumed or locked-out output.
3. **The evidence is inspectable.** Two matched configurations provide 315 recorded events, raw guest logs, source snapshots, checks and an event-linked replay.

## Verified film, 2 minutes 38 seconds

The final local movie is 158.32 seconds at 1440 × 1000, with 33 English caption cues and no audio. It begins with a new QNX guest execution and then moves into the archived-event UI. Chrome decoded checkpoints in the native run, response table, rejection, lockout and evidence sections. [Media check](../prototype/artifacts/demo-video-check.json) · [Native capture receipt](../prototype/artifacts/demo-native-capture.json)

| Time | Picture and explanation | Evidence to preserve |
|---|---|---|
| 0:00–0:46 | New execution: boot QNX, receive native guest serial events, complete seven scenarios, and show successful guest and host checks. | The fresh 203-event run is bound to the capture's exact video, console, source and recorder digests. |
| 0:46–1:23 | Startup validation, invalid command rejection, replacement generation and fresh proposals restoring output. | The workbench is explicitly recorded replay. Selected events match the pinned baseline trace. |
| 1:23–1:31 | Compare notice-to-hold and hold-to-outcome intervals for both policies. | Baseline invalid: 11 ms to hold, 280 ms to validated resume. No restarts: zero-output lockout. These are recorded measurements. |
| 1:31–2:26 | Repeated sequence, wrong generation, bounded repeated-crash recovery and zero-restart containment. | In-range protocol faults, generation change, finite budget and output values remain visible. |
| 2:26–2:38 | End on the original evidence, configurations and simulation limits. | Raw guest logs, source snapshots and digest checks accompany both policy recordings. |

The decoded duration is below the public overview's under-three-minute requirement. Emulated guest timestamps are distinct from presentation time; physical output and hardware timing are outside the measurements. [Official overview](https://qnx.devpost.com/)

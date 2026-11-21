# Dependencies and external tools

The MIT license at the repository root covers this project's own source, documentation, UI and recordings. It does not grant rights to separately installed vendor tools, operating systems, logos or trademarks.

| Component | Use | Included here |
|---|---|---|
| QNX SDP 8.0, compiler, runtime and image tools | Compile and run the native guest program | No. Obtain and license separately from QNX. |
| QEMU | Emulate the x86-64 guest on the Windows host | No. Obtain separately from the QEMU project or its linked Windows distributor. |
| Python standard library | Check evidence, package the demo, serve local files | Own Python source only; no Python distribution. |
| Playwright 1.65.1, Apache-2.0 | Optional browser tests and UI screencast | Dependency declaration and lockfile only; no package binaries. |
| Chrome and Playwright FFmpeg/Winldd | Optional screencast capture | No. Browser and recording tools are installed separately. |

The browser UI uses system fonts and original HTML/CSS. No external font, stock illustration, music or third-party logo is bundled. The WebM and PNG assets record this project's own UI. Console logs contain guest execution evidence, and C snapshots contain this project's own program; licensed QNX executables and VM images are excluded.

QNX is referenced to identify the target platform. This project is an independent prototype and makes no claim of vendor certification or endorsement.

Tool references: [QNX Everywhere](https://qnx.software/en/developers/get-started/qnx-everywhere), [QEMU downloads](https://www.qemu.org/download/), [Playwright license](https://github.com/microsoft/playwright/blob/main/LICENSE).


# Version 1.0.0 release report

Release date: 2026-08-16

## Delivered simulator

Version 1.0.0 is a native arm64 macOS Tauri application named **Guidance
Estimation Laboratory**. The native bundle is at:

```text
src-tauri/target/release/bundle/macos/Guidance Estimation Laboratory.app
```

It contains the common 200 Hz deterministic kernel, planar and selectable 6-DOF
dynamics, the limited-FOV stochastic seeker, raw and EKF tracking, pure pursuit and
proportional navigation, paired statistical studies, replay/scrubbing, synchronized
Three.js diagnostics, CSV/JSON exports, and Worker supervision.

The current two-workspace engineering interface adds a tabular experiment manifest,
world X–Z symbology, measurement provenance, innovation-gate status, display-only
track-quality classification, frozen run identifiers, qualification status, and
audit/replay counters. It explicitly identifies its synthetic data basis and lack of
field calibration or live sensor integration.

The software-only acoustic extension adds a configurable homogeneous-water
environment, Mackenzie sound speed, Thorp absorption, logarithmic spreading, a
synthetic active-echo link budget, seeded probability of detection, and two-way
propagation delay. It does not add BELLHOP ray tracing, hardware connections, or
field-validation claims.

The current default 6-DOF setup adds a published civilian BlueROV2 Heavy reference
profile using the coefficient mapping recorded in `docs/hydrodynamic-reference.md`.
The historical demonstration continues to use its frozen fictional coefficient set.

A portable archive of the bundle is next to it at
`Guidance-Estimation-Laboratory-1.0.0-macos-arm64.zip` (3.7 MB, SHA-256
`a118372270ab3632880ea2281c4ae8439f78c2afb55c141b44496ef16a1255f2`).

The bundle is 11 MB, targets arm64 macOS, embeds version `1.0.0`, and passes strict
deep code-signature verification. It is ad-hoc signed with hardened runtime; it is
not Developer-ID signed or notarized because Apple distribution credentials are not
part of this repository. Executable SHA-256:

```text
aa2e29d007e45154728d4c2a068b08bbf7b5fab39624148d23f1f89d880fa844
```

## Demo evidence

The checked-in media is a capture of the real application frontend driven by its
simulation Worker. The archived deterministic reference preset fixes seed `20260814`, configuration hash
`a5b937df`, fictional 6-DOF dynamics, scripted target maneuver, EKF observation
mode, proportional navigation, tactical diagnostics, and 4× time scale. The run
terminated as an intercept at 44.610 simulation seconds with a 13.95 m closest
approach and 3.3% command saturation.

| Artifact | Format | Size | SHA-256 |
| --- | --- | ---: | --- |
| `assets/guidance-estimation-demo.mp4` | H.264 High, yuv420p, 1536×1000, 10 fps, 12 s | 1.2 MB | `769d439dfbebb0dba3572bb96819c53ed25551d5d49a2a94c684ac7d2af30cd8` |
| `assets/guidance-estimation-demo.gif` | GIF89a, 800×520, 8 fps, 12 s | 6.8 MB | `21d5b75af6ba57aede303ce5e540a23ff5786ea88eec4f6f778b2cb4e6c05e3c` |
| `assets/guidance-estimation-demo-poster.png` | PNG, 1537×1000 | 587 KB | `5d214167860b6916b93f433d0c8d53a674843393fa60e63661e6adb720d77ad2` |

FFmpeg decoded every one of the MP4's 120 frames without an error. The capture
completed without an application exception. The frame-signature-aware encoder is
available as `scripts/encode-demo-video.ts` and produces all three artifacts from
the same numbered sequence.

## Verification matrix

- Vitest: 18 files, 55 tests passed.
- Strict TypeScript and Vite production build: passed.
- ESLint: passed without warnings.
- Rust `cargo check`: passed.
- Tauri release build: passed.
- macOS `codesign --verify --deep --strict`: passed.
- Production UI demo: Worker reached a normal intercept and published the expected
200/100/50/20 Hz status channels. The current engineering interface retains the
reference configuration in code but no longer presents it as a prominent demo button.
- Existing numerical soak evidence: 600 simulated seconds and 120,000 physics steps
  completed for both dynamics implementations with finite state.
- Existing paired fidelity evidence: 96 deterministic engagements across nominal
  and isolation conditions reproduced the reported guidance result.

## Scientific boundary

This is a production-quality educational and portfolio simulator, not a validated
platform model. The civilian reference coefficients are diagonal and configuration-
dependent, target sensing is
deliberately simplified, and no operational acoustic, propulsion, warhead, platform,
or external targeting data is present. Numerical and software verification does not
turn fictional hydrodynamic coefficients into real-vehicle validation.

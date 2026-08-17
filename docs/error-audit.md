# Error audit — 2026-08-14

## 2026-08-16 version 1.0 release audit

The completed native simulator was re-audited after the portfolio-demo and media
pipeline were added. A deterministic `PORTFOLIO DEMO` preset now records the
fictional 6-DOF, scripted-evasive, EKF-assisted PN run at seed `20260814` and 4×
wall-clock speed. Its actual UI was captured through the production frontend; the
12-second H.264 file decodes through all 120 frames and the companion GIF and PNG
were generated from the same sequence.

The media audit found one pipeline defect before release: captured frames contained
JPEG data despite a PNG filename. The encoder now validates frame signatures,
selects the correct decoder, enforces even H.264 dimensions, and converts the poster
to genuine PNG data. The simulation run itself completed normally with a 13.95 m
closest approach and no browser runtime error.

Version consistency was checked across npm, Cargo, Tauri, and replay metadata. The
event schema is 2 because the replay event union now records the demo-preset action.
The final verification result is recorded in `docs/release-report.md`.

## 2026-08-16 Phase 5–6 audit addendum

Before the fidelity work, the complete 0.4.0 baseline passed 40 tests, the strict
TypeScript/Vite/ESLint pipeline, Rust `cargo check`, and a 600-second/120,000-step
finite-state soak. No baseline numerical regression was found, so the planar path
was retained unchanged behind the new `VehicleDynamics` interface.

Implementation review then found and corrected two presentation/schema defects:

1. Adding a second analysis panel compressed live telemetry to an unusable strip at
   the minimum native window height. Estimation and fidelity analysis now use an
   explicit accessible tab switch and reserve a minimum telemetry viewport.
2. The new dynamics and telemetry fields changed persisted contracts. Configuration
   is now schema 2, replay/telemetry are schema 2, the Monte Carlo report is schema
   2, and the Worker protocol is version 3. Older structures are rejected explicitly
   rather than being accepted under their previous version numbers.

The final 0.6.0 audit covers quaternion normalization, level trim, neutral
equilibrium, damping, control-surface lag, timestep refinement, 6-DOF engagement
containment, fidelity determinism, desktop runtime logs, production assets, and the
native Rust shell. The detailed evidence is in `docs/phase-5-6-report.md`.

## Scope

The audit covered the deterministic engine, 2.5D dynamics, 3D engagement geometry,
sensor timing/noise/dropout, EKF update and covariance handling, guidance interfaces,
Monte Carlo pairing, consistency statistics, CSV/JSON exports, and external
configuration validation.

## Corrected defects

1. **Horizontal-only intercept geometry.** Interception and closest approach used
   horizontal range even when the vehicle was at a different depth. Truth range,
   closing velocity, predicted closest approach, and termination now use full 3D
   geometry. The fictional surface target reference point is eight metres below the
   surface and the independent depth controller converges to it.
2. **Incomplete external configuration validation.** Non-finite dropout, timing,
   vehicle, estimator, and guidance values could pass validation and fail later in
   integration. Configuration now rejects non-finite values, invalid enums,
   inconsistent depth coordinates, impossible speed commands, invalid ranges, and
   nonpositive response constants before an engine is created.
3. **Misaligned consistency ensembles.** NIS and NEES arrays were aligned by array
   index. A detection dropout could shift an entire run relative to the others.
   Consistency samples now carry simulation timestamps and ensemble means are aligned
   by timestamp.
4. **Overstated consistency regression.** One test implied the baseline EKF was
   universally consistent in the constant-turn case. The result is seed-ensemble and
   scenario dependent. The test now verifies deterministic, bounded reporting rather
   than forcing a preferred scientific conclusion, and the limitation is documented.

## Verification

- 29 unit, numerical, statistical, and integration tests passed.
- TypeScript compilation and ESLint passed without warnings.
- Invalid runtime mode input was rejected before simulation.
- A final 180-engagement paired matrix covered three scenarios, two guidance laws,
  three observation modes, and ten shared seeds.
- The final matrix contained zero invalid-state terminations and zero non-finite
  primary metrics. It produced 175 interceptions and five classified track-loss
  outcomes, all in noisy raw-observation configurations.

Artifacts are stored in `outputs/error-check/final/` as JSON, run-level CSV, summary
CSV, histogram bins, and empirical CDF points.

## Remaining model limitations

- NIS is close to its expected value and passed the ensemble check in the final
  matrix. NEES did not pass across the tested scenarios, showing that the current
  constant-velocity process model and single process-noise setting do not describe
  every maneuver regime consistently.
- The correct next estimator improvement is a turn-rate/acceleration model or IMM,
  followed by a new paired consistency study—not cosmetic covariance tuning.
- The default civilian profile uses published coefficients, but their diagonal
  implementation and reduced actuation model do not make this a validated physical
  vehicle model. The archived high-speed profile remains fictional.

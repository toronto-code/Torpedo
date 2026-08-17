# Phase 3 native presentation report

## Delivered

- Native Tauri 2 application shell with macOS, Windows, Linux, iOS, and Android
  icon assets generated from the project-owned vector mark.
- React engineering workstation UI and direct Three.js scene; no game engine and
  no hosted website.
- Tactical orthographic, chase, and seeker cameras.
- Ocean shader, fictional guided vehicle and target meshes, sensor field-of-view
  sector, true/estimated trails, raw observation marker, 95% covariance ellipse,
  CPA line, and optional velocity vectors.
- Live range, bearing, closing velocity, LOS rate, CPA, track, innovation,
  covariance, depth, actuator, and saturation instrumentation.
- Synchronized plots for LOS rate, estimation error/uncertainty, NIS/NEES, and
  actuator command/response.
- Scenario, seed, ablation mode, guidance law, noise, dropout, FOV, navigation
  constant, time-scale, diagnostic, and camera controls.
- Pause, resume, exact 5 ms single-step, reset, deterministic restart, native CSV
  export, and background paired Monte Carlo analysis with JSON export.

## Runtime invariants

- `SimulationEngine` remains authoritative at 200 Hz with fixed-step RK4.
- The real-time Worker publishes compact snapshots at 50 Hz and telemetry at 20 Hz.
- Rendering interpolates received snapshots and cannot call dynamics, sensing,
  estimation, or guidance functions.
- Monte Carlo executes in an independent Worker using the same headless kernel.
- Ground truth remains unavailable to estimator and guidance module contracts.

## Verification completed

- 31 unit/regression tests pass across 11 test files.
- TypeScript strict type-check, Vite production asset build, ESLint, and native
  Rust `cargo check` pass.
- Native Tauri debug application launches successfully.
- Optimized native release build succeeds as an arm64 macOS application bundle.
- Visual QA confirmed tactical, chase, and seeker camera paths, WebGL rendering,
  live telemetry, synchronized plots, completion summary, and control layout.
- Interaction QA confirmed Worker startup, pause/resume, an exact 0.005-second
  explicit step, and a 12-engagement paired Monte Carlo result.
- Browser/runtime console was checked; the only Three.js deprecation warning was
  removed by using the current shadow-map constant.
- npm reports zero production or development dependency vulnerabilities after
  applying the available transitive tooling updates.

## Deliberate Release 1 limits

The coefficients remain fictional and the validated dynamics are 2.5D. Replay
schema hardening and the 6-DOF fidelity study remain Phase 4 and Phase 5 research
releases. Installer signing/notarization is also outside this local implementation;
the current production command builds the native executable directly.

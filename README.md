# Torpedo Guidance Simulator


**guidance and state estimation under
sensor uncertainty** project. The simulator is a native desktop application, not a hosted
website. Its deterministic kernel provides selectable validated 2.5D and 6-DOF
vehicle dynamics in **NED coordinates** (x = North, y = East, z = Down), with an
optional published civilian BlueROV2 Heavy reference profile,
a limited-FOV noisy seeker, raw tracking, an Extended
Kalman Filter, pure pursuit, proportional navigation, ablation runs, and CSV
telemetry. An optional software-only acoustic channel adds configurable water-column
properties, analytic spreading and absorption, a synthetic echo link budget,
probability of detection, and two-way propagation latency. An optional **phased
weapon engagement** adds fire-control launch solutions, run-out/homing/terminal
phases with reacquisition search, speed stages with an endurance budget, a
proximity fuze, and a synthetic effectiveness score for benchmarking — all
parameters fictional and uncalibrated (see `docs/weapon-model.md`).

The default interactive experience opens the full 3D setup: 6-DOF dynamics,
a water surface and seabed with a depth ruler, 3D trails, and an orbit camera
(alongside chase, top-down, and seeker views). The original synthetic
high-speed configuration with two visible vehicles remains the headless
default, and a civilian ROV
coefficient profile remains available for low-speed comparison. The purpose is
numerical methods, estimator consistency, control limits, and reproducible experimentation.

The native interface is organized as two engineering workspaces. **Simulation**
contains the 3D world view with camera modes, a configuration manifest, explicit observer/track/
measurement/covariance symbology, estimator-quality state, measurement provenance,
and an immutable run record. **Analysis** contains paired synthetic experiments,
the model-qualification basis, and replay/audit evidence. Track-quality labels are
derived for presentation only and never enter estimation, guidance, or control.

## Run the simulator

```bash
npm install
npm run desktop
npm run sim:headless
npm run sim:compare
npm run sim:headless -- --mode raw --law pure-pursuit --scenario scripted-evasive
npm run sim:compare -- --seed 42 --csv outputs/engagement.csv
npm run sim:monte-carlo -- --runs 20 --seed 42
npm run sim:weaponeering -- --runs 8
npm run sim:fidelity -- --runs 8 --scenario scripted-evasive
npm run sim:soak -- --duration 600
npm run sim:soak -- --duration 600 --dynamics six-dof
npm run test:unit
```

`npm run desktop` opens the Tauri application. `npm run desktop:package` builds
the native macOS application bundle without producing an installer; Release 1
intentionally has no hosted deployment. Telemetry exports are written to
`Documents/Guidance Estimation Laboratory` by the native shell.

The historical reference run remains reproducible in the configuration library:
seed `20260814`, fictional 6-DOF dynamics, scripted evasive target, noisy
EKF-assisted tracking, proportional navigation, and 4× wall-clock speed. It is no
longer exposed as a presentation-oriented button in the engineering workspace.
The checked-in video was captured from that preset and includes the real
Worker-driven simulation and live telemetry. To regenerate it from a numbered frame sequence, run
`npm run demo:encode -- --frames work/demo-frames --out assets`; FFmpeg must be
available on `PATH` (or supplied with `--ffmpeg /absolute/path/to/ffmpeg`).

The authoritative Worker advances at 200 Hz with fixed-step RK4. Autopilot runs
at 100 Hz, guidance and render snapshots at 50 Hz, and telemetry at 20 Hz. The
Three.js display interpolates snapshots at display refresh rate and cannot advance
simulation state; camera modes, overlays, and trails are render-only state.
Seeker observations retain their measurement timestamp and are
delivered after modeled latency. Simulation coordinates are NED; a single
documented conversion layer maps them into the Three.js render frame.

See [docs/architecture.md](docs/architecture.md) for the runtime boundary and
timing model, [docs/phase-3-report.md](docs/phase-3-report.md) for the desktop
implementation and QA report, and [docs/statistical-validation.md](docs/statistical-validation.md)
for the Stage 2 experiment methodology. The latest corrective review is recorded in
[docs/error-audit.md](docs/error-audit.md). Stage 4 replay, profiling, numerical
soak, and Worker recovery behavior is documented in
[docs/phase-4-report.md](docs/phase-4-report.md). The 6-DOF implementation and
paired fidelity result are documented in
[docs/phase-5-6-report.md](docs/phase-5-6-report.md). The acoustic equations,
public research basis, and limitations are in
[docs/acoustic-model.md](docs/acoustic-model.md). The civilian coefficient mapping,
source values, and remaining limitations are documented in
[docs/hydrodynamic-reference.md](docs/hydrodynamic-reference.md).

## Ablation modes

- `perfect`: adapts truth into a zero-uncertainty `TrackEstimate` for a declared
  experimental baseline.
- `raw`: converts only delivered bearing/range observations and estimates
  velocity through finite differences.
- `ekf`: applies a four-state constant-velocity EKF with nonlinear bearing/range
  measurement updates, Joseph-form covariance correction, angle wrapping, and
  Mahalanobis innovation gating.

All modes use identical scenario and sensor seeds for paired comparisons.


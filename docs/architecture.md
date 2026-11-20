# Runtime architecture

The simulator retains a deterministic, headless kernel. It deliberately
separates truth dynamics from the information available to the tracker and guidance
law.

```text
Scenario ──> Truth dynamics (200 Hz RK4) ──> Acoustic channel ──> Seeker (8 Hz)
                    │                                               │ delayed observations
                    │                                               ▼
                    │                                       Raw tracker + EKF
                    │                                               │ TrackEstimate only
                    │                                               ▼
                    └────────────────────────────────────── Guidance (50 Hz)
                                                                    │
                                                             Autopilot (100 Hz)
                                                                    │
                                                                    └──> truth dynamics
```

## Coordinate system

Simulation state uses **NED coordinates**: x = North, y = East, z = Down
(depth is positive down). Positions are metres, velocities m/s, angular
rates rad/s internally; the UI converts angles to degrees. The horizontal
guidance/estimation/sensing boundary (`Vec2`, `TrackEstimate`,
`NavigationInput`) consumes the (North, East) pair only.

Three.js keeps its native right-handed Y-up rendering space. Exactly one
conversion layer (`src/desktop/scene/coordinates.ts`) maps between the
frames — `render.x = sim.x`, `render.y = -sim.z`, `render.z = sim.y` — and
conjugates orientation quaternions accordingly. It is a proper rotation
(handedness-preserving); components never perform ad-hoc axis swaps. The
kernel previously used an x/z-horizontal, y-up convention; the migration
is a pure relabeling rotation and is regression-verified (see
Reproducibility).

## Orientation

Quaternions are the canonical internal orientation representation in both
dynamics models; Euler angles are derived for telemetry and UI only via a
ZYX NED extraction (`orientationAngles`, inverse of `quaternionFromEuler`).
The 6-DOF body frame is x = forward, y = starboard, z = down. Procedural
meshes are built nose-forward along body +X, matching the render
conversion; an explicit model-orientation adapter would be added only for
imported meshes with a different forward axis.

## Timing

| Process | Rate | Physics ticks |
| --- | ---: | ---: |
| Physics integration | 200 Hz | 1 |
| Autopilot | 100 Hz | 2 |
| Guidance | 50 Hz | 4 |
| Worker snapshot | 50 Hz | 4 |
| Telemetry | 20 Hz | 10 |
| Seeker | 8 Hz default | timestamp scheduled |

The background simulation protocol publishes compact snapshots at 50 Hz. The
native Tauri application interpolates these snapshots at display refresh rate; it
never advances simulation state. Decimated 20 Hz telemetry feeds plots and exports.
Explicit single-step commands force a display snapshot without changing the normal
continuous-run publication cadence.

## Native presentation boundary

The Tauri process provides the application window and scoped text export command.
React owns experiment controls and engineering instrumentation. Direct Three.js owns
the ocean, vehicles, trails, seeker field of view, observation and estimate markers,
95% covariance ellipse, velocity vectors, and CPA geometry. A separate analysis
Worker executes Monte Carlo experiments so statistics cannot block either rendering
or the authoritative real-time Worker.

The 3D scene shows a translucent water surface at zero depth, a seabed at the
configured `environment.waterDepth`, a depth ruler with metre ticks and labels,
and exponential fog for vertical perspective. Vehicle trails are bounded
full-3D ring buffers (default 2,000 points, configurable via `SceneOptions`)
that preserve vertical separation and never reallocate per point. Four camera
modes are available: **Orbit** (default; rotate, zoom, pan, double-click to
refocus the engagement midpoint), **Chase** (smoothed follow behind/above the
observer), **Top Down** (the orthographic tactical view), and **Seeker**
(onboard first-person, gated by lock status). Camera selection and all camera
state live purely in React/scene state; there is no path into
`SimulationConfig`, its hash, or the Worker.

The plan display uses the NED frame through the single conversion layer
described above. The grid interval is 100 m. Observer trajectory, estimated
track, delivered measurement, 95% position covariance, velocity vectors, and CPA
geometry have separate symbology. The UI's tentative/confirmed/coasting/stale/
rejected track-quality label is derived only from published estimate age, validity,
observation sequence, seeker state, and gate result. It is presentation metadata and
is structurally absent from estimator, guidance, and control inputs.

The source includes a Vite development asset server because Tauri uses it for hot
reload, but Release 1 is packaged and run as a native application. There is no
hosted deployment or website delivery target.

## Truth boundary

`computeGuidance` accepts `NavigationInput`, which contains ownship navigation data
and a `TrackEstimate`. It cannot accept a target `VehicleState`. Perfect-information
experiments use an adapter that deliberately creates a zero-uncertainty
`TrackEstimate`; raw and EKF experiments use only delivered observations.

The EKF retains state at the latest processed observation timestamp. Because sensor
latency is ordered, it predicts to each observation time, updates there, and produces
a non-mutating prediction to the current guidance time. This avoids treating a
delayed measurement as though it were current.

## Integration and dynamics

The authoritative timestep is 0.005 seconds. A `VehicleDynamics` interface selects
the validated planar baseline or the 6-DOF implementation without
changing sensing, estimation, guidance, scheduling, telemetry, or rendering
contracts.

The tracked target is planar by default. Setting the optional
`target.dynamicsModel` to `six-dof` is the explicit opt-in for full 3D
target motion: the engine then integrates the target through the same
6-DOF model and drives it toward its commanded depth with a depth
autopilot. `VehicleInitialState` also accepts optional `pitch`, `roll`,
and `verticalSpeed` (positive down). The opt-in exists because the paired
2.5D/6-DOF fidelity studies deliberately keep the target planar to
isolate guided-vehicle fidelity; default scenarios must keep producing
their previous trajectories.

The planar model integrates horizontal position, heading, speed, positive-down
depth, depth rate, and yaw rate. Speed, turn, and depth commands pass through
first-order response dynamics plus acceleration and rate limits.

The 6-DOF path integrates world position, a normalized body-to-world quaternion,
body linear velocity, body angular velocity, rudder and elevator state, and
propulsion state. It uses diagonal rigid and added mass/inertia, gravity, buoyancy,
quadratic and linear damping, restoring moment from the center-of-buoyancy offset,
control-surface or reduced vectored-thrust forces/moments, propulsion lag, and a
deterministic time-varying current. The default experience uses the generic
high-speed synthetic profile; an optional civilian BlueROV2 Heavy profile provides
published diagonal coefficients for low-speed comparison. A bounded numerical trim solver establishes initial
level propulsion equilibrium and reports residual force and moment.

The seeker and horizontal EKF continue to use horizontal bearing/range in both
models; those subsystems form the documented planar adapter boundary at the
`Vec2`/`TrackEstimate` interfaces and consume North/East components only.
Depth is controlled by an independent outer loop toward the
configured depth reference; in 6-DOF that demand drives the elevator rather
than directly prescribing vertical motion. Intercept,
truth range, closing velocity, and closest approach use full three-dimensional
geometry, so horizontal coincidence at the wrong depth is not counted as success.

## Autonomous multi-contact engagement

The optional `contacts` block adds ground-truth contacts (kinds, per-contact
acoustics, scripted behaviors, decoy deployment) evaluated by one anonymous
multi-return seeker. A nearest-neighbor tracker maintains track files; a
classifier accumulates evidence from observables only (implied target
strength, kinematics, a synthetic friendly-marking correlation); TEWA
designates under a fictional doctrine and gates the engagement behind
manual or autonomous authorization. Results score engagement correctness.
Identity never crosses the observation boundary; legacy single-target runs
are bit-identical. See [autonomous-engagement.md](autonomous-engagement.md).

## Weapon engagement

The optional `weapon` configuration block phases the engagement: run-out on
the frozen fire-control solution, homing, terminal (stricter gate, sprint,
higher seeker cadence), and deterministic reacquisition search. Fire control
and phase decisions consume only the delivered `TrackEstimate`; the fuze is
the one truth-geometry consumer, isolated like the acoustic channel. An
endurance budget and a proximity fuze add the `endurance-exhausted` and
`fuzed-detonation` termination reasons, and a synthetic effectiveness score
(fictional constants) is attached to results without any path back into
control. Without the block, behavior is bit-identical to the legacy
continuous-guidance engagement. See [weapon-model.md](weapon-model.md).

## Software-only acoustic environment

The optional acoustic channel is a bounded analytic approximation. It evaluates
Mackenzie sound speed from configured temperature, salinity, and mean path depth;
Thorp volume absorption at the configured frequency; configurable logarithmic
spreading; a synthetic two-way active-echo link budget; logistic probability of
detection; and two-way propagation delay. Channel detection has its own derived
random stream, preserving independence from sensor noise and configured dropout.

This is not a BELLHOP-compatible ray tracer. It does not model a range/depth sound-
speed profile, multipath arrivals, surface or bottom reflection, reverberation,
beam patterns, Doppler processing, waveform ambiguity, or real transducer data.
See [acoustic-model.md](acoustic-model.md) for equations, sources, and validation.

## Reproducibility

Every run has a seed and stable configuration hash. Sensor noise and sensor dropout
use independently derived random streams, so adding draws to one subsystem does not
silently alter the other. Headless and rendered runs share the same
`SimulationEngine`.

Backward compatibility across the NED coordinate migration is enforced by
`tests/ned-regression.test.ts` against golden fixtures captured from the
pre-migration kernel: planar scenarios reproduce bit-identically and 6-DOF
runs agree to floating-point round-off (measured worst case 4.5e-13 m against
a documented 1e-9 absolute tolerance, consistent with the project's 1e-10
relative determinism basis). Pre-migration six-DOF configuration data
(center-of-buoyancy, currents) is not portable across the convention change;
no persisted artifacts in this repository depend on it.

Stage 4 adds a `ReplayRecorder` at the desktop runtime boundary. It records the
already-decimated 50 Hz snapshots and 20 Hz telemetry, so recording does not widen
the Worker protocol or expose hidden state. Timeline lookup truncates both streams
at the chosen frame timestamp; the live Worker is paused while a captured replay is
being inspected. A separate verification Worker reruns the embedded frozen
configuration through the same headless kernel and compares terminal metrics and a
terminal evidence digest.

The simulation Worker protocol is independently versioned. The desktop sends a
one-second heartbeat, rejects protocol mismatches, and performs at most three
automatic deterministic restarts after a crash or ten-second loss of contact.
Restarts begin at simulation time zero from the frozen configuration and preserve
the prior run/pause intent; they are not hidden checkpoint continuations.

## Fidelity experiment boundary

The fidelity Worker runs six paired variants per guidance law: planar baseline,
nominal 6-DOF, low/high actuator lag, and low/high 6-DOF control authority. Every
variant uses the same seed, target scenario, sensor stream construction, EKF, and
guidance configuration. It reduces the termination radius to 0.25 m and evaluates
success against the configured 14 m threshold, allowing closest approach to remain
an informative continuous metric instead of being clipped at the normal intercept
boundary. Run-level results, paired deltas, distributions, approximate 95% mean
confidence intervals, and the generated conclusion are exportable.

## Dynamics models: reference vs fidelity

The **planar-2.5D model is the engagement reference**. Every preset's
outcome mix, the statistical baseline gates, and the default run are
calibrated and validated on it. The **six-DOF model is an opt-in
vehicle-fidelity mode** for dynamics studies (actuator lag, currents,
attitude) — it is deterministic and physics-tested at the vehicle level,
but the engagement chain is *not* tuned for it: under six-DOF the
weapon's slower trajectory changes classification timing and terminal
geometry, and several presets that are near-perfect on the reference
model (cluttered approach, silent approach) fail to complete. Selecting
6-DOF in the control panel is a fidelity experiment, not an alternative
validated scenario set; validating it is future work.

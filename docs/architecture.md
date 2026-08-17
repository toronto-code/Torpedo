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

The plan display uses the Three.js world X–Z horizontal plane with +Y up; it is not
an ENU geodetic frame. The grid interval is 100 m. Observer trajectory, estimated
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
contracts. The surface target remains planar in both cases so the experiment
isolates guided-vehicle fidelity.

The planar model integrates horizontal position, heading, speed, positive-down
depth, depth rate, and yaw rate. Speed, turn, and depth commands pass through
first-order response dynamics plus acceleration and rate limits.

The 6-DOF path integrates world position, a normalized body-to-world quaternion,
body linear velocity, body angular velocity, rudder and elevator state, and
propulsion state. It uses diagonal rigid and added mass/inertia, gravity, buoyancy,
quadratic and linear damping, restoring moment from the center-of-buoyancy offset,
control-surface or reduced vectored-thrust forces/moments, propulsion lag, and a
deterministic time-varying current. The default profile uses published civilian
BlueROV2 Heavy diagonal coefficients; the archived generic profile retains fictional
sensitivity parameters. A bounded numerical trim solver establishes initial
level propulsion equilibrium and reports residual force and moment.

The seeker and horizontal EKF continue to use horizontal bearing/range in both
models. Depth is controlled by an independent outer loop toward a fictional
submerged target reference point; in 6-DOF that demand drives the elevator rather
than directly prescribing vertical motion. Intercept,
truth range, closing velocity, and closest approach use full three-dimensional
geometry, so horizontal coincidence at the wrong depth is not counted as success.

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

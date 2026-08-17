# Stage 4 — Replay and Reproducibility Hardening

## Outcome

Stage 4 is complete in application version `0.4.0`. The native simulator now
records a versioned evidence package for each run, can scrub the recorded scene
and plots on a common timeline, and can rerun a completed engagement through the
headless kernel to verify its terminal result. The authoritative simulation
remains in the 200 Hz Worker; replay is read-only and cannot advance physics.

## Replay contract

A replay contains:

- format, application, replay, configuration, event, and telemetry versions;
- the complete frozen `SimulationConfig`, its hash, and the scenario seed;
- 50 Hz render frames, 20 Hz telemetry, runtime profile samples, and ordered events;
- the terminal `ExperimentResult` and a digest over the configuration hash,
  terminal result, and final telemetry sample.

Import validates schema compatibility, the 5 ms physics timestep, ordered
timestamps and indexes, finite profile values, configuration/hash agreement,
seed/configuration agreement, and terminal-digest integrity. Incompatible or
tampered files are rejected with an explicit reason rather than being partially
loaded.

The initial schemas are deliberately strict and versioned independently:

| Contract | Version |
| --- | ---: |
| Replay envelope | 1 |
| Configuration | 1 |
| Discrete events | 1 |
| Telemetry | 1 |
| Worker protocol | 2 |

## Recorded events

Runs record their seed and configuration hash at creation. The event stream also
captures pause, resume, single-step, reset, time-scale changes, configuration
changes, camera changes, diagnostic-overlay changes, replay imports, Worker
failure, recovery, and run completion. Configuration changes retain their field
path and before/after values and are marked as applying on the next restart.

## Timeline and verification

`ENTER REPLAY` freezes a point-in-time copy of the recorder and pauses a running
engagement. Previous/next controls and the timeline slider select a 50 Hz frame.
The scene trails and 20 Hz plot history are reconstructed only through the
selected timestamp, so scene, HUD, and charts cannot display future data.

For a completed replay, `VERIFY` runs the frozen configuration in a separate
verification Worker using the same headless `SimulationEngine`. Verification
compares termination reason, elapsed time, closest approach, final range,
estimation metrics, observation counts, and saturation fraction at a declared
`1e-9` tolerance. It also requires the configuration hash and terminal digest to
match. This directly tests the Stage 4 acceptance condition instead of treating
successful JSON import as reproducibility.

## Worker recovery and profiling

The desktop runtime sends one heartbeat per second and requires Worker contact
within ten seconds. A crash or heartbeat timeout triggers a bounded automatic
restart with the frozen configuration and time scale. Recovery restarts the run
from simulation time zero, records the interruption, and preserves whether the
operator had the run paused. Three attempts are allowed before the runtime enters
an explicit error state. A Worker protocol mismatch is rejected and is not
silently recovered.

Once per simulated second the Worker reports step, snapshot, and telemetry-batch
counts, real-time factor, and maximum scheduler backlog. The compact profile is
recorded with the replay and displayed in the replay health strip.

## Validation evidence

The Stage 4 suite adds coverage for:

- JSON round-trip and terminal digest stability;
- deterministic rerun and primary-metric parity;
- incompatible replay and event versions;
- configuration, seed, and result tampering;
- unordered frame data and synchronized telemetry lookup;
- Worker crash restart with the frozen configuration;
- explicit Worker protocol rejection;
- a finite 60-second numerical soak in the automated suite.

The standalone prolonged check is:

```bash
npm run sim:soak -- --duration 600
```

The current 600-second reference run executes 120,000 fixed physics steps,
emits 12,000 telemetry samples, terminates by the configured timeout, and keeps
all inspected coordinates, ranges, and covariance traces finite. Exact wall time
depends on the host and is intentionally reported rather than asserted.

The optimized arm64 macOS `.app` is reproducibly ad-hoc signed for local use and
passes strict bundle signature verification. Apple Developer ID signing and
notarization require external credentials and remain a distribution step rather
than a simulation feature.

## Recovery semantics and limitations

- Recovery is deterministic restart, not checkpoint continuation. The UI states
  this through generation and recovery counters, and the replay records the
  restart boundary.
- Replay reconstructs recorded 50 Hz presentation state; it does not serialize
  hidden 200 Hz integrator internals.
- Replay verification guarantees parity on the current JavaScript numerical
  runtime and declared metrics. Cross-engine floating-point equivalence is only
  promised within the declared tolerance.
- Stage 5's 6-DOF model is not part of this release and no operational vehicle
  fidelity is claimed.

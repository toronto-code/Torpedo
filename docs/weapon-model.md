# Weapon engagement model

The optional `weapon` configuration block turns the guided vehicle into a
phased engagement weapon. Without the block the simulator keeps its original
continuous-guidance behavior, bit-identically (see
`tests/ned-regression.test.ts` and `tests/weapon-system.test.ts`).

All parameters below are synthetic, fictional, and uncalibrated. They exist
to make engagement-phasing algorithms measurable against the estimator and
guidance stack — not to describe any real weapon.

## Information boundary

Fire control, the homing phase machine, and all engagement decisions consume
only the delivered `TrackEstimate` — the same delayed, noisy track the
guidance law sees — plus ownship navigation data. The one exception is the
fuze: like the acoustic channel, it is a physical proximity sensor that reacts
to true geometry. It lives in its own module (`src/sim/fuze.ts`) so the
exception is auditable.

## Phases

| Phase | Behavior |
| --- | --- |
| `run-out` | Heading-hold on the frozen fire-control solution until the enable time/distance. Guidance law idle. |
| `homing` | The existing pursuit / proportional-navigation law on the delivered track. |
| `terminal` | Same law; stricter association gate, optional higher seeker cadence, sprint speed. |
| `reacquisition` | Deterministic loiter (configured turn rate, default full turn rate) after the track is lost longer than the configured window; resumes the prior phase on reacquisition. |

Prolonged loss re-births the EKF track so the next delivered observation
re-initializes it. This is engine-level track management; the estimator
implementation is untouched.

Track usability credits the modeled delivery delay (sensor latency plus
acoustic propagation) of the last observation, because a fresh observation
delivered 3 s late is not a stale observation.

## Fire control

`src/sim/fire-control.ts` freezes a launch solution at launch: closed-form
collision-course lead heading from the estimated track velocity and cruise
speed, predicted intercept point and run time, an advisory enable point, and
a worst-case launch envelope. Fireability (fresh, valid, gating track; a
solvable intercept inside the endurance budget) is advisory — the operator
can always fire manually. `src/sim/intercept.ts` holds the pure geometry.

## Fuze and synthetic effectiveness

The fuze arms after the enable schedule and triggers when the true 3D
separation falls inside the detection radius (optional seeded jitter from the
dedicated `fuze` random stream). Triggering terminates the run with
`fuzed-detonation` and records the miss distance. Endurance budgets terminate
with `endurance-exhausted`.

Effectiveness is `exp(-(miss / lethalRadius)^shape)` — a smooth decreasing
synthetic scoring curve with fictional constants. It is consumed only by
results and the UI and cannot influence guidance, estimation, or control.
It is a benchmarking metric, not a lethality or damage-physics model.

## Weaponeering

`npm run sim:weaponeering -- --runs 8` (or the Analysis workspace panel) runs
a paired-seed sweep over weapon-design variants — endurance, enable schedule,
cruise speed, terminal gate — reporting detonation/intercept/exhaustion
rates, mean closest approach, and mean synthetic effectiveness with paired
deltas against the baseline preset.

# Phase 5–6 — 6-DOF Fidelity Study

## Scope decision

The prior roadmap defined Phase 5 but did not define a Phase 6. For this release,
the combined research scope was split at a natural boundary:

- **Phase 5:** replaceable fictional 6-DOF numerical model, trim, tests, and native
  full-attitude visualization.
- **Phase 6:** paired 2.5D/6-DOF experiment, actuator-lag/control-authority isolation,
  confidence reporting, exports, and the workstation analysis panel.

The fidelity features were completed in `0.6.0` and ship in application version
`1.0.0`. Configuration schema is 2, replay, telemetry, and event schemas are 2,
Monte Carlo report schema is 2, and Worker protocol is 3.

## Phase 5 numerical model

The 6-DOF state comprises world position, a normalized body-to-world quaternion,
body velocity, body angular rate, rudder, elevator, and propulsion state. RK4 runs
at the same authoritative 200 Hz as the planar model. The simplified equations are:

```text
p_dot = R(q) v_body
q_dot = 0.5 q ⊗ [0, omega_body]
M v_dot = force - omega × (M v)
I omega_dot = moment - omega × (I omega)
```

Forces include propulsion, gravity, buoyancy, deterministic current-relative
linear/quadratic damping, and control-surface lift. Moments include surface moment,
angular damping, and buoyancy restoring moment. Added mass and added inertia are
generic diagonal terms. Propulsion and control surfaces have independent first-order
lag. The 100 Hz outer autopilot converts the existing yaw-rate, depth-rate, and
speed commands into those actuator targets.

The body frame is right-handed: +X forward, +Y up, +Z right. World coordinates
remain Three.js +X right, +Y up, +Z horizontal. Positive project heading rotates
from world +X toward +Z, corresponding to rotation about world -Y.

The trim routine solves required level axial propulsion by bounded bisection, checks
the thrust limit, and reports residual force and moment. The default fictional model
is neutrally buoyant and begins in level trim. It is not calibrated to a real vehicle.

## Phase 6 experiment design

The reference study uses the scripted-evasive scenario, EKF observations, both
guidance laws, and eight paired seeds (`20260814`–`20260821`). Each seed is run under:

1. 2.5D baseline;
2. nominal 6-DOF;
3. 6-DOF actuator lag ×0.35;
4. 6-DOF actuator lag ×2.0;
5. 6-DOF control authority ×0.65;
6. 6-DOF control authority ×1.5.

The study runs 96 deterministic engagements. To measure closest approach instead of
stopping at the normal 14 m intercept boundary, study runs use a 0.25 m termination
radius and score interception against the original 14 m threshold. Approximate 95%
mean confidence intervals are reported for all paired deltas. The complete local
JSON and CSV evidence is generated under `outputs/fidelity-study/reference/`.

Control effort is the RMS of three normalized actuator channels. It is useful for
paired sensitivity within a model, but it is not an energy or fuel measure and its
absolute value should not be compared as though a planar speed command and a 6-DOF
thrust fraction were identical hardware.

Reproduce it with:

```bash
npm run sim:fidelity -- --runs 8 --scenario scripted-evasive \
  --out outputs/fidelity-study/reference
```

## Reference result

| Model / law | Intercept rate | Mean CPA | Mean control effort | Saturation |
| --- | ---: | ---: | ---: | ---: |
| 2.5D / pursuit | 100% | 4.72 m | 0.622 | 47.3% |
| 2.5D / PN | 100% | 0.75 m | 0.522 | 0.5% |
| 6-DOF / pursuit | 0% | 25.64 m | 0.409 | 36.1% |
| 6-DOF / PN | 100% | 4.56 m | 0.353 | 1.4% |

PN's mean closest-approach advantage was 3.97 m in 2.5D and 21.08 m in 6-DOF,
so the stated advantage persisted in this experiment. Moving nominal PN from 2.5D
to 6-DOF added a 3.81 m CPA penalty (approximate 95% CI 3.29–4.33 m), demonstrating
that fidelity changes absolute performance even though it does not reverse the
guidance ranking.

For PN, doubling actuator lag added 1.42 m CPA (95% CI 1.36–1.48 m), while reducing
control authority to 0.65× added 0.18 m (95% CI -0.06–0.41 m). The latter interval
includes zero. Because the nominal 6-DOF penalty exceeded either isolated sweep,
the automated report classifies vehicle coupling as the largest tested factor, with
actuator lag a clear secondary factor.

This is a result for the declared fictional coefficients and eight paired seeds,
not a universal claim about marine vehicles or real guidance systems.

## Verification

- 48 tests across 15 test files pass.
- Trim residual, quaternion norm, level equilibrium, actuator lag, timestep
  refinement, configuration rejection, and integrated 6-DOF containment are tested.
- Fidelity records, group summaries, paired effects, and conclusions reproduce
  exactly from identical configurations and seeds.
- Separate 600-second soaks completed 120,000 physics steps per model with finite
  state. Maximum quaternion norm error was `2.22e-16` for the planar representation
  and zero at sampled telemetry points for 6-DOF.
- Strict TypeScript, Vite production build, ESLint, and native Rust checks pass.
- Browser-harness QA of the native asset bundle confirmed model switching,
  attitude/actuator telemetry, the paired fidelity Worker, accessible study tabs,
  and a clean runtime console.

## Limitations

- Coefficients are intentionally fictional and diagonal; there is no CFD-derived
  coefficient set, cross-flow model, cavitation, or acoustic propagation.
- The target and seeker measurement model remain planar. The guided vehicle alone
  changes fidelity, which is useful experimentally but not a full ocean simulator.
- The current is deterministic and smoothly varying, not a turbulence spectrum.
- The trim solver targets level constant-speed equilibrium, not a full maneuvering
  trim family.
- The reference study is intentionally small. More seeds and broader coefficient
  priors are required before treating sensitivity rankings as stable.

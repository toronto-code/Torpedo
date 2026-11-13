# Autonomous engagement

Multi-contact engagement turns the simulator into a detect → track →
classify → legitimize → select → authorize → engage chain. All labels,
doctrine, and parameters are synthetic and fictional.

## Identity boundary

Ground-truth contact identity is consumed only by truth dynamics, truth
symbology, and results/scoring. Observations are anonymous and carry
features: bearing/range, echo-derived implied target strength (spreading
removed), and a synthetic friendly-marking correlation — a fictional IFF
analog the seeker receiver always measures (high for marked contacts,
baseline otherwise). Classification, association, selection, and
authorization consume features/estimates only.

## Pipeline

* **Seeker**: independent per-contact pings with dedicated seed streams;
  per-contact target strength feeds the existing link budget.
* **Tracker** (`tracker.ts`): nearest-neighbor Mahalanobis association,
  tentative/confirmed/coasting/deleted lifecycle, delivery-delay-aware
  staleness. Cross-track swaps on crossing geometry are an expected,
  survivable failure mode.
* **Classifier** (`classify.ts`): log-space evidence with exponential
  forgetting over implied TS, kinematic bands, heading wander, and the
  signature correlation; softmax confidence. "unknown" is a fixed-evidence
  fallback. Classification lag is the experiment.
* **TEWA** (`tewa.ts`): doctrine-driven legitimacy and exclusions
  (friendly/commercial/biological/unknown/decoy), hysteresis-stabilized
  designation, and an authorization gate — manual (engine-enforced
  hold-fire until the operator authorizes) or autonomous (sustained
  doctrine satisfaction). Pipeline stages are logged as replay events.
* **Weapon**: phases/fuze follow the designated track; the fuze resolves
  the nearest true contact; results score engagement correctness
  (correct-hostile / decoy-seduction / wrong-contact / miss).

## Studies

`npm run sim:engagement -- --runs 6` sweeps the ambiguity presets
(crossing subs, cluttered approach, decoy stress, ambiguous fluctuator,
combined high ambiguity) on paired seeds with outcome mixes and
time-to-authorize. Legacy single-target configurations are bit-identical
(golden regression).

## Countermeasures

The decoy-stress preset carries the full layered terminal defense in the
classic order: **decoy** (mobile, strong stable echo) deployed at 650 m,
then a **knuckle** at 420 m — the turbulence cloud left by a hard turn,
modeled as a near-stationary contact whose echo strength decays linearly
(1.2 dB/s) after deployment. A knuckle presents a loud fresh echo that can
steal a vacant designation during track confusion, then fades, forcing the
weapon back to search — burning time and battery against its energy budget.

Two weapon-side answers exist:

- **Doppler-style fuze discrimination** (`fuze.minTargetSpeedMs`): contacts
  moving slower than the gate cannot actuate the influence fuze, so
  near-stationary scatter (turbulence, bottom features) is ignored while
  hard maneuvering targets still trigger. Scoring treats knuckle kills as
  countermeasure seduction.
- **Quiet search speed** (`weapon.speed.searchSpeed`): during reacquisition
  the weapon slows to 18 m/s; with the self-noise model this genuinely
  lowers flow noise and widens the effective detection cone — search slow,
  sprint to kill.

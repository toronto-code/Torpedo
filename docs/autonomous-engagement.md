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

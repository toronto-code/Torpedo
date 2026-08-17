# Stage 2 statistical validation

Stage 2 evaluates the simulator as a stochastic experiment rather than relying on
individual visual runs. Every comparison is paired: competing estimator or guidance
configurations receive the same base seed, scenario, and sensor-model parameters.

## Consistency metrics

The innovation sequence is evaluated with the normalized innovation squared (NIS),
which has two degrees of freedom for bearing/range observations. State-estimation
error is evaluated with normalized estimation error squared (NEES), which has four
degrees of freedom for the `[x, z, vx, vz]` filter state.

Reports include:

- observed mean and theoretical expected mean;
- per-time-index ensemble means across independent seeded runs;
- aggregate 95% chi-square mean intervals using the number of independent runs;
- the fraction of time indices whose ensemble mean falls inside its interval;
- individual-sample 95% coverage.

The aggregate interval uses the Wilson–Hilferty chi-square approximation. Time
samples within one engagement are not counted as independent trials. Results are
evidence about the fictional simulation model, not claims about operational hardware.

The baseline process noise is a documented compromise rather than a claim that the
filter is consistent in every scenario. Constant turns and scripted evasive motion
violate the EKF's constant-velocity process model; a failed NEES check is therefore a
useful model-mismatch result, not something the report hides or automatically tunes
away. NIS and NEES pass/fail results must be reported with the scenario and seed
ensemble that produced them.

## Paired comparisons

The Monte Carlo runner supports two controlled comparisons:

- EKF versus raw observations with scenario, guidance law, and seed held fixed;
- proportional navigation versus pure pursuit with scenario, estimator mode, and
  seed held fixed.

The report records closest-approach deltas and the fraction of pairs won by the left
configuration. A negative delta means the left configuration achieved a smaller
closest approach.

## Outputs

`npm run sim:monte-carlo` writes:

- `report.json`: complete versioned report;
- `runs.csv`: one row per engagement;
- `summary.csv`: group-level confidence intervals and consistency metrics;
- `histogram.csv`: closest-approach histogram bins;
- `cdf.csv`: empirical closest-approach CDF points.

Every engagement includes its seed and stable configuration hash.

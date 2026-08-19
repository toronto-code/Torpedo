import type { WeaponeeringReport } from "../../analysis/weaponeering";
import type { AnalysisProgress } from "../monteCarlo";

interface Props {
  running: boolean;
  progress: AnalysisProgress | null;
  report: WeaponeeringReport | null;
  runCount: number;
  onRunCount: (count: number) => void;
  onRun: () => void;
  onExport: () => void;
}

const percent = (value: number) => `${(value * 100).toFixed(0)}%`;

export function WeaponeeringPanel(props: Props) {
  return (
    <section className="qualification-panel panel">
      <div className="panel-title">
        <span>WEAPONEERING · PAIRED PARAMETER SWEEP</span>
        <span>SYNTHETIC EFFECTIVENESS</span>
      </div>
      <p className="parameter-note">
        Paired-seed Monte Carlo over weapon-design variants (endurance, enable
        schedule, cruise speed, terminal gate). Effectiveness is the synthetic
        scoring function — fictional constants, uncalibrated, for algorithm
        comparison only.
      </p>
      <div className="analysis-controls">
        <label>
          RUNS / VARIANT
          <input
            type="number"
            min={1}
            max={40}
            value={props.runCount}
            onChange={(event) => props.onRunCount(Math.max(1, Number(event.target.value) || 1))}
          />
        </label>
        <button type="button" disabled={props.running} onClick={props.onRun}>
          {props.running ? "RUNNING…" : "RUN SWEEP"}
        </button>
        {props.report && <button type="button" onClick={props.onExport}>EXPORT</button>}
      </div>
      {props.progress && (
        <progress className="analysis-progress" max={props.progress.total} value={props.progress.completed} />
      )}
      {props.report && (
        <table className="config-table">
          <thead>
            <tr>
              <th>VARIANT</th>
              <th>DETONATION</th>
              <th>INTERCEPT</th>
              <th>EXHAUSTED</th>
              <th>MEAN CPA</th>
              <th>SYNTHETIC EFFECTIVENESS</th>
            </tr>
          </thead>
          <tbody>
            {props.report.variants.map((variant) => (
              <tr key={variant.id}>
                <td title={variant.description}>{variant.label}</td>
                <td>{percent(variant.detonationRate)}</td>
                <td>{percent(variant.interceptRate)}</td>
                <td>{percent(variant.exhaustionRate)}</td>
                <td>{variant.meanClosestApproach.toFixed(1)} m</td>
                <td>{variant.meanEffectiveness === null ? "—" : variant.meanEffectiveness.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {props.report && (
        <p className="parameter-note">
          Paired deltas are computed against the baseline preset on identical
          seeds. Requires a PHASED weapon configuration.
        </p>
      )}
    </section>
  );
}

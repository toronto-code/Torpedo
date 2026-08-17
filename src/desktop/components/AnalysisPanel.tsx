import type { MonteCarloReport } from "../../analysis/types";
import type { AnalysisProgress } from "../monteCarlo";

interface Props {
  running: boolean;
  progress: AnalysisProgress | null;
  report: MonteCarloReport | null;
  runCount: number;
  onRunCount: (count: number) => void;
  onRun: () => void;
  onExport: () => void;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function AnalysisPanel(props: Props) {
  const ekfPn = props.report?.groups.find((group) => group.mode === "ekf" && group.law === "proportional-navigation");
  const rawPn = props.report?.groups.find((group) => group.mode === "raw" && group.law === "proportional-navigation");
  const comparison = props.report?.comparisons.find(
    (entry) => entry.dimension === "estimator" && entry.left === "ekf" && entry.right === "raw" && entry.key.includes("proportional-navigation"),
  );
  const progress = props.progress && props.progress.total > 0
    ? props.progress.completed / props.progress.total
    : 0;
  return (
    <section className="analysis-panel panel">
      <div className="panel-title"><span>PAIRED MONTE CARLO</span><span>SHARED SEEDS</span></div>
      <div className="analysis-controls">
        <label>PAIRS <input type="number" min="2" max="100" value={props.runCount} onChange={(event) => props.onRunCount(Math.max(2, Number(event.target.value)))} /></label>
        <button type="button" onClick={props.onRun} disabled={props.running}>{props.running ? "RUNNING…" : "RUN ANALYSIS"}</button>
        <button type="button" onClick={props.onExport} disabled={!props.report}>EXPORT JSON</button>
      </div>
      {props.running && (
        <div className="progress"><i style={{ width: `${progress * 100}%` }} /><span>{props.progress?.completed ?? 0} / {props.progress?.total ?? 0}</span></div>
      )}
      <div className="analysis-results">
        <div><span>EKF + PN SUCCESS</span><strong>{ekfPn ? pct(ekfPn.successRate) : "—"}</strong></div>
        <div><span>RAW + PN SUCCESS</span><strong>{rawPn ? pct(rawPn.successRate) : "—"}</strong></div>
        <div><span>EKF CPA ADVANTAGE</span><strong>{comparison ? `${(-comparison.meanClosestApproachDelta).toFixed(1)} m` : "—"}</strong></div>
      </div>
    </section>
  );
}

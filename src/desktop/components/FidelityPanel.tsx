import type { FidelityStudyReport } from "../../analysis/types";
import type { AnalysisProgress } from "../monteCarlo";

interface Props {
  running: boolean;
  progress: AnalysisProgress | null;
  report: FidelityStudyReport | null;
  runCount: number;
  onRunCount: (count: number) => void;
  onRun: () => void;
  onExport: () => void;
}

export function FidelityPanel(props: Props) {
  const progress = props.progress && props.progress.total > 0
    ? props.progress.completed / props.progress.total
    : 0;
  const conclusion = props.report?.conclusion;
  const nominalPn = props.report?.groups.find(
    (group) => group.variant === "six-dof-nominal" && group.law === "proportional-navigation",
  );
  return (
    <section className="fidelity-panel panel">
      <div className="panel-title"><span>FIDELITY STUDY</span><span>PAIRED 2.5D / 6-DOF</span></div>
      <div className="analysis-controls">
        <label>PAIRS <input type="number" min="1" max="30" value={props.runCount} onChange={(event) => props.onRunCount(Math.max(1, Number(event.target.value)))} /></label>
        <button type="button" onClick={props.onRun} disabled={props.running}>{props.running ? "RUNNING…" : "RUN FIDELITY"}</button>
        <button type="button" onClick={props.onExport} disabled={!props.report}>EXPORT JSON</button>
      </div>
      {props.running && (
        <div className="progress"><i style={{ width: `${progress * 100}%` }} /><span>{props.progress?.completed ?? 0} / {props.progress?.total ?? 0}</span></div>
      )}
      <div className="analysis-results fidelity-results">
        <div><span>PLANAR PN ADV.</span><strong>{conclusion ? `${conclusion.planarPnAdvantage.toFixed(2)} m` : "—"}</strong></div>
        <div><span>6-DOF PN ADV.</span><strong>{conclusion ? `${conclusion.sixDofPnAdvantage.toFixed(2)} m` : "—"}</strong></div>
        <div><span>6-DOF PN INTERCEPT</span><strong>{nominalPn ? `${(nominalPn.interceptRate * 100).toFixed(0)}%` : "—"}</strong></div>
        <div><span>LIMITING FACTOR</span><strong>{conclusion?.likelyLimitingFactor.toUpperCase() ?? "—"}</strong></div>
      </div>
    </section>
  );
}

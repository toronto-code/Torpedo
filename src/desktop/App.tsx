import { useMemo, useState } from "react";

import type { FidelityStudyReport, MonteCarloReport } from "../analysis/types";
import type { WeaponeeringReport } from "../analysis/weaponeering";
import { parseReplay, serializeReplay } from "../replay/codec";
import { telemetryThroughTime } from "../replay/timeline";
import type { ReplayFile, ReplayVerification } from "../replay/types";
import { hashConfig } from "../sim/config";
import { createAmbiguityScenarioConfig, type AmbiguityPreset } from "../sim/scenarios";
import { telemetryToCsv } from "../sim/csv";
import type { SimulationConfig } from "../sim/types";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { ControlPanel } from "./components/ControlPanel";
import { FidelityPanel } from "./components/FidelityPanel";
import { MiniPlot } from "./components/MiniPlot";
import { ReplayTimeline } from "./components/ReplayTimeline";
import { SimulationViewport } from "./components/SimulationViewport";
import type { CameraMode } from "./scene/SimulationScene";
import { TelemetryPanel } from "./components/TelemetryPanel";
import { WeaponeeringPanel } from "./components/WeaponeeringPanel";
import { exportText } from "./export";
import { runFidelityAnalysis } from "./fidelityAnalysis";
import { runAnalysis, runWeaponeeringAnalysis, type AnalysisProgress } from "./monteCarlo";
import { verifyReplayAsync } from "./replayVerification";
import { useSimulation } from "./useSimulation";

const degrees = (value: number) => (value * 180) / Math.PI;

export function App() {
  const [runtime, view] = useSimulation();
  // The interactive default is the tuned high-ambiguity preset: six contacts,
  // phased weapon engagement with an energy battery, and the orbit camera.
  // The preset's weapon block and planar weapon dynamics are kept intact —
  // they are the configuration the engagement studies validate. Seed chosen
  // so the first-run story is a clean hostile interception.
  const [config, setConfig] = useState<SimulationConfig>(() =>
    createAmbiguityScenarioConfig("high-ambiguity", 20260816),
  );
  const [scenario, setScenario] = useState<AmbiguityPreset>("high-ambiguity");
  const [cameraMode, setCameraMode] = useState<CameraMode>("orbit");
  const [timeScale, setTimeScale] = useState(1);
  const [showTruth, setShowTruth] = useState(true);
  const [showDiagnostics, setShowDiagnostics] = useState(true);
  const [workspace, setWorkspace] = useState<"simulation" | "analysis">("simulation");
  const [analysisRuns, setAnalysisRuns] = useState(8);
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress | null>(null);
  const [report, setReport] = useState<MonteCarloReport | null>(null);
  const [fidelityRuns, setFidelityRuns] = useState(2);
  const [fidelityRunning, setFidelityRunning] = useState(false);
  const [fidelityProgress, setFidelityProgress] = useState<AnalysisProgress | null>(null);
  const [fidelityReport, setFidelityReport] = useState<FidelityStudyReport | null>(null);
  const [weaponeeringRuns, setWeaponeeringRuns] = useState(6);
  const [weaponeeringRunning, setWeaponeeringRunning] = useState(false);
  const [weaponeeringProgress, setWeaponeeringProgress] = useState<AnalysisProgress | null>(null);
  const [weaponeeringReport, setWeaponeeringReport] = useState<WeaponeeringReport | null>(null);
  const [activeReplay, setActiveReplay] = useState<ReplayFile | null>(null);
  const [replayFrameIndex, setReplayFrameIndex] = useState(0);
  const [verification, setVerification] = useState<ReplayVerification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const updateTimeScale = (next: number) => {
    setTimeScale(next);
    runtime.setTimeScale(next);
  };

  const updateConfig = (next: SimulationConfig) => {
    runtime.recordConfigChange(config, next);
    setConfig(next);
    setVerification(null);
  };

  // Selecting a scenario preset starts a fresh experiment from the tuned
  // preset: per-contact noise, doctrine, and the weapon block all come from
  // the scenario, so the engagement studies stay representative.
  const selectScenario = (preset: AmbiguityPreset) => {
    setScenario(preset);
    updateConfig(createAmbiguityScenarioConfig(preset, config.seed));
  };

  const updateTruth = (next: boolean) => {
    runtime.recordUserEvent("overlay-change", { overlay: "truth", value: next });
    setShowTruth(next);
  };

  const updateDiagnostics = (next: boolean) => {
    runtime.recordUserEvent("overlay-change", { overlay: "diagnostics", value: next });
    setShowDiagnostics(next);
  };

  const exportTelemetry = async () => {
    const samples = activeReplay
      ? telemetryThroughTime(activeReplay, activeReplay.frames[replayFrameIndex]?.snapshot.timestamp ?? 0)
      : view.telemetry;
    if (samples.length === 0) return;
    try {
      const location = await exportText(
        `engagement-${config.seed}-${hashConfig(config)}.csv`,
        telemetryToCsv(samples),
      );
      setNotice(`Telemetry exported: ${location}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const enterReplay = () => {
    const replay = runtime.getReplay();
    if (!replay || replay.frames.length === 0) return;
    if (view.status === "running") runtime.pause();
    setActiveReplay(replay);
    setReplayFrameIndex(replay.frames.length - 1);
    setVerification(null);
  };

  const exitReplay = () => {
    setActiveReplay(null);
    setReplayFrameIndex(0);
    setVerification(null);
  };

  const exportReplay = async () => {
    const replay = activeReplay ?? runtime.getReplay();
    if (!replay) return;
    try {
      const location = await exportText(
        `replay-${replay.seed}-${replay.configHash}.replay.json`,
        serializeReplay(replay),
      );
      setNotice(`Replay exported: ${location}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const importReplay = async (file: File) => {
    try {
      const replay = parseReplay(await file.text());
      if (view.status === "running") runtime.pause();
      runtime.recordUserEvent("replay-loaded", {
        fileName: file.name,
        configHash: replay.configHash,
        schemaVersion: replay.schemaVersion,
      });
      setActiveReplay(replay);
      setReplayFrameIndex(0);
      setConfig(structuredClone(replay.config));
      setVerification(null);
      setNotice(`Replay loaded: ${replay.frames.length} frames, ${replay.events.length} events.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const verifyActiveReplay = async () => {
    if (!activeReplay?.result) return;
    setVerifying(true);
    try {
      const result = await verifyReplayAsync(activeReplay);
      setVerification(result);
      setNotice(
        result.deterministic
          ? `Replay verified exactly in ${result.elapsedWallMs.toFixed(1)} ms.`
          : "Replay verification diverged; inspect the recorded metric differences.",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setVerifying(false);
    }
  };

  const runMonteCarlo = async () => {
    setAnalysisRunning(true);
    setAnalysisProgress({ completed: 0, total: analysisRuns * 6 });
    try {
      const next = await runAnalysis(analysisRuns, config, setAnalysisProgress);
      setReport(next);
      setNotice(`Paired analysis completed: ${next.records.length} engagements.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setAnalysisRunning(false);
    }
  };

  const exportAnalysis = async () => {
    if (!report) return;
    try {
      const location = await exportText(
        `monte-carlo-${report.baseSeed}.json`,
        JSON.stringify(report, null, 2),
      );
      setNotice(`Analysis exported: ${location}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const runFidelity = async () => {
    setFidelityRunning(true);
    setFidelityProgress({ completed: 0, total: fidelityRuns * 12 });
    try {
      const next = await runFidelityAnalysis(fidelityRuns, config, setFidelityProgress);
      setFidelityReport(next);
      setNotice(next.conclusion.statement);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setFidelityRunning(false);
    }
  };

  const exportFidelity = async () => {
    if (!fidelityReport) return;
    try {
      const location = await exportText(
        `fidelity-${fidelityReport.baseSeed}-${fidelityReport.configHash}.json`,
        JSON.stringify(fidelityReport, null, 2),
      );
      setNotice(`Fidelity report exported: ${location}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const runWeaponeering = async () => {
    if (!config.weapon) {
      setNotice("Weaponeering requires a PHASED weapon configuration.");
      return;
    }
    setWeaponeeringRunning(true);
    setWeaponeeringProgress({ completed: 0, total: weaponeeringRuns * 6 });
    try {
      const next = await runWeaponeeringAnalysis(weaponeeringRuns, config, setWeaponeeringProgress);
      setWeaponeeringReport(next);
      setNotice(`Weaponeering sweep completed: ${next.variants.length} variants × ${next.runsPerVariant} runs.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setWeaponeeringRunning(false);
    }
  };

  const exportWeaponeering = async () => {
    if (!weaponeeringReport) return;
    try {
      const location = await exportText(
        `weaponeering-${weaponeeringReport.baseSeed}-${weaponeeringReport.configHash}.json`,
        JSON.stringify(weaponeeringReport, null, 2),
      );
      setNotice(`Weaponeering report exported: ${location}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const replayTime = activeReplay?.frames[replayFrameIndex]?.snapshot.timestamp ?? 0;
  const displaySnapshot = activeReplay?.frames[replayFrameIndex]?.snapshot ?? view.snapshot;
  const displayTelemetry = useMemo(
    () => activeReplay
      ? telemetryThroughTime(activeReplay, replayTime)
      : view.telemetry,
    [activeReplay, replayTime, view.telemetry],
  );
  // Engagement pipeline events derived from telemetry transitions, so the
  // timeline is available live and in replay without engine changes.
  const engagementEvents = useMemo(() => {
    const events: {
      at: number;
      kind: "designate" | "redesignate" | "lost" | "authorize";
      label: string;
    }[] = [];
    let designated: number | null = null;
    let authorized = false;
    for (const sample of displayTelemetry) {
      const engagement = sample.engagement;
      if (!engagement) continue;
      if (engagement.designatedTrackId !== designated) {
        const next: number | null = engagement.designatedTrackId;
        if (next === null && designated !== null) {
          events.push({ at: sample.timestamp, kind: "lost", label: `track ${designated} lost` });
        } else if (next !== null && designated === null) {
          events.push({ at: sample.timestamp, kind: "designate", label: `designate track ${next}` });
        } else if (next !== null) {
          events.push({ at: sample.timestamp, kind: "redesignate", label: `redesignate ${designated} → ${next}` });
        }
        designated = next;
      }
      if (engagement.authorized && !authorized) {
        authorized = true;
        events.push({
          at: sample.timestamp,
          kind: "authorize",
          label: `authorized${designated !== null ? ` · track ${designated}` : ""}`,
        });
      }
    }
    return events;
  }, [displayTelemetry]);
  const replayHistory = useMemo(
    () => activeReplay?.frames.slice(0, replayFrameIndex + 1).map((frame) => frame.snapshot),
    [activeReplay, replayFrameIndex],
  );
  const displayResult = activeReplay
    ? (replayFrameIndex === activeReplay.frames.length - 1 ? activeReplay.result : null)
    : view.result;
  const latest = displayTelemetry.at(-1);
  const estimatedError = latest?.estimationPositionError;
  const activeConfigHash = activeReplay?.configHash ?? view.activeConfigHash ?? hashConfig(config);
  const positionUncertainty = (sample: (typeof displayTelemetry)[number]) => {
    const covariance = sample.estimate?.covariance;
    if (!covariance) return null;
    const summedPositionVariance = Math.max(0, (covariance[0]?.[0] ?? 0) + (covariance[1]?.[1] ?? 0));
    return 2 * Math.sqrt(summedPositionVariance / 2);
  };

  return (
    <main className="application-shell">
      <header className="topbar">
        <div className="product-identity">
          <span className="system-mark">GEL</span>
          <div>
            <h1>UNDERWATER VEHICLE TRACKING SIMULATOR</h1>
            <span className="eyebrow">{config.dynamics.sixDof.profile === "bluerov2-heavy-2024" ? "OPTIONAL CIVILIAN REFERENCE · RESEARCH MODEL" : "SYNTHETIC HIGH-SPEED DYNAMICS · RESEARCH MODEL"}</span>
          </div>
        </div>
        <nav className="workspace-switch" aria-label="Workspace">
          <button type="button" className={workspace === "simulation" ? "selected" : ""} onClick={() => setWorkspace("simulation")}>SIMULATION</button>
          <button type="button" className={workspace === "analysis" ? "selected" : ""} onClick={() => setWorkspace("analysis")}>ANALYSIS</button>
        </nav>
        <div className="runtime-identifiers">
          <span>200 Hz RK4</span>
          <span>RUN CFG {activeConfigHash}</span>
          <span>SEED {config.seed}</span>
          <span className={`runtime-state ${view.status}`}>{view.status}</span>
          <button type="button" disabled={displayTelemetry.length === 0} onClick={exportTelemetry}>EXPORT TELEMETRY</button>
        </div>
      </header>

      {workspace === "simulation" ? <div className="workspace-grid">
        <ControlPanel
          config={config}
          status={view.status}
          initialized={view.activeConfigHash !== null}
          timeScale={timeScale}
          showTruth={showTruth}
          showDiagnostics={showDiagnostics}
          scenario={scenario}
          onScenario={selectScenario}
          onConfig={updateConfig}
          onTimeScale={updateTimeScale}
          onTruth={updateTruth}
          onDiagnostics={updateDiagnostics}
          onRun={() => {
            exitReplay();
            runtime.start(config, timeScale);
          }}
          onPauseResume={() => view.status === "running" ? runtime.pause() : runtime.resume()}
          onStep={() => runtime.step()}
          onReset={() => {
            exitReplay();
            runtime.reset();
          }}
        />

        <section className="visual-stage">
          <SimulationViewport
            snapshot={displaySnapshot}
            cameraMode={cameraMode}
            showTruth={showTruth}
            showDiagnostics={showDiagnostics}
            fovHalfAngle={config.sensor.fovHalfAngle}
            waterDepth={config.environment?.waterDepth}
            trailLimit={2_000}
            replayHistory={replayHistory}
          />
          <div className="camera-select" role="group" aria-label="Camera mode">
            {config.doctrine?.mode === "manual" && (
              <button type="button" onClick={() => runtime.authorize()}>AUTHORIZE</button>
            )}
            {(["orbit", "chase", "tactical", "seeker"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={cameraMode === mode ? "selected" : ""}
                onClick={() => {
                  runtime.recordUserEvent("camera-change", { mode });
                  setCameraMode(mode);
                }}
              >
                {mode === "orbit" ? "ORBIT" : mode === "chase" ? "CHASE" : mode === "tactical" ? "TOP DOWN" : "SEEKER"}
              </button>
            ))}
          </div>
          <div className="view-overlay top-left">
            <span>NED · +X NORTH · +Y EAST · +Z DOWN · GRID 100 m</span>
            <strong>T+ {(displaySnapshot?.timestamp ?? 0).toFixed(3)} s</strong>
          </div>
          <div className="view-overlay bottom-left">
            <span className="legend observer">OBSERVER PATH</span>
            {showTruth && <span className="legend truth">GROUND TRUTH</span>}
            <span className="legend estimate">TRACK ESTIMATE</span>
            <span className="legend observation marker">MEASUREMENT</span>
            <span className="legend covariance">95% POSITION COVARIANCE</span>
          </div>
          <div className="frame-indicator" aria-label="World coordinate frame">
            <i className="axis-z">+E</i><i className="axis-x">+N</i><b />
          </div>
          {view.error && <div className="error-banner">SIMULATION HALTED — {view.error}</div>}
          {displayResult && (
            <div className={`result-banner ${displayResult.terminationReason}`}>
              <strong>{displayResult.terminationReason === "intercept" ? "INTERCEPT" : displayResult.terminationReason.toUpperCase()}</strong>
              <span>closest approach {displayResult.closestApproach.toFixed(2)} m</span>
              <span>elapsed {displayResult.elapsedTime.toFixed(2)} s</span>
              <span>saturation {(displayResult.saturationFraction * 100).toFixed(1)}%</span>
              {displayResult.engagedContact && (
                <span>engaged {displayResult.engagedContact.id} · {displayResult.engagementOutcome}</span>
              )}
              {displayResult.fuzeMissDistance !== undefined && (
                <span>fuze miss {displayResult.fuzeMissDistance.toFixed(2)} m</span>
              )}
              {displayResult.effectivenessScore !== undefined && (
                <span>synthetic effectiveness {displayResult.effectivenessScore.toFixed(3)}</span>
              )}
            </div>
          )}
        </section>

        <div className="right-stack">
          <TelemetryPanel
            snapshot={displaySnapshot}
            config={config}
            events={engagementEvents}
            eventDuration={config.runtime.maxTime}
          />
          <section className="run-record">
            <div className="panel-title"><span>RUN RECORD</span><span>IMMUTABLE AFTER INIT</span></div>
            <dl>
              <div><dt>CONFIG HASH</dt><dd>{activeConfigHash}</dd></div>
              <div><dt>RANDOM SEED</dt><dd>{config.seed}</dd></div>
              <div><dt>MODEL REVISION</dt><dd>CFG-v{config.version} / {(displaySnapshot?.torpedo.dynamicsModel ?? config.dynamics.model).toUpperCase()}</dd></div>
              <div><dt>NUMERICAL STEP</dt><dd>{(1_000 / config.runtime.physicsHz).toFixed(3)} ms</dd></div>
              <div><dt>EVENT LOG</dt><dd>{view.replay.events} VERSIONED EVENTS</dd></div>
              <div><dt>DATA BASIS</dt><dd>SYNTHETIC / ANALYTIC ACOUSTIC</dd></div>
              <div><dt>INPUT BUS</dt><dd>SIMULATED STREAM / NO I/O</dd></div>
              <div><dt>CALIBRATION</dt><dd>USER CONFIG / NOT FIELD FIT</dd></div>
            </dl>
            <p>NOT VALIDATED FOR OPERATIONAL USE. Ground truth is structurally unavailable to estimation and control.</p>
          </section>
        </div>

        <ReplayTimeline
          summary={view.replay}
          replay={activeReplay}
          playback={activeReplay !== null}
          frameIndex={replayFrameIndex}
          verification={verification}
          verifying={verifying}
          recoveries={view.workerRecoveries}
          profile={view.profile}
          onEnter={enterReplay}
          onExit={exitReplay}
          onFrame={setReplayFrameIndex}
          onExport={exportReplay}
          onImport={importReplay}
          onVerify={verifyActiveReplay}
        />

        <section className="plot-deck">
          <MiniPlot
            title="LINE-OF-SIGHT RATE"
            unit="deg/s"
            samples={displayTelemetry}
            symmetric
            series={[{ label: "λ̇", color: "#8fb0c1", value: (sample) => degrees(sample.metrics.losRate) }]}
          />
          <MiniPlot
            title="TRACK ERROR / UNCERTAINTY"
            unit="m"
            samples={displayTelemetry}
            series={[
              { label: "error", color: "#c1a16d", value: (sample) => sample.estimationPositionError },
              { label: "position 2σ RMS", color: "#769eb5", value: positionUncertainty },
            ]}
          />
        </section>
      </div> : (
        <section className="analysis-workspace">
          <header className="analysis-header">
            <div>
              <span className="section-index">ANALYSIS / PAIRED EXPERIMENTS</span>
              <h2>ESTIMATOR AND MODEL FIDELITY</h2>
            </div>
            <p>Batch studies reuse paired seeds. Results describe the selected synthetic model and are not evidence of operational performance.</p>
          </header>
          <div className="analysis-grid">
            <AnalysisPanel
              running={analysisRunning}
              progress={analysisProgress}
              report={report}
              runCount={analysisRuns}
              onRunCount={setAnalysisRuns}
              onRun={runMonteCarlo}
              onExport={exportAnalysis}
            />
            <FidelityPanel
              running={fidelityRunning}
              progress={fidelityProgress}
              report={fidelityReport}
              runCount={fidelityRuns}
              onRunCount={setFidelityRuns}
              onRun={runFidelity}
              onExport={exportFidelity}
            />
            <WeaponeeringPanel
              running={weaponeeringRunning}
              progress={weaponeeringProgress}
              report={weaponeeringReport}
              runCount={weaponeeringRuns}
              onRunCount={setWeaponeeringRuns}
              onRun={runWeaponeering}
              onExport={exportWeaponeering}
            />
            <section className="qualification-panel panel">
              <div className="panel-title"><span>MODEL QUALIFICATION BASIS</span><span>STATUS: RESEARCH ONLY</span></div>
              <dl>
                <div><dt>DATA ORIGIN</dt><dd>Deterministic synthetic scenarios</dd></div>
                <div><dt>PAIRING METHOD</dt><dd>Shared seeds across estimator, controller, and fidelity variants</dd></div>
                <div><dt>NUMERICAL EVIDENCE</dt><dd>Finite-state soak, replay digest, RK4 regression tests</dd></div>
                <div><dt>ESTIMATOR EVIDENCE</dt><dd>NIS, NEES, covariance coverage, innovation gating</dd></div>
                <div><dt>ACOUSTIC EVIDENCE</dt><dd>Analytic spreading, Thorp absorption, Mackenzie sound speed, seeded detection</dd></div>
                <div><dt>HYDRODYNAMIC BASIS</dt><dd>{config.dynamics.sixDof.profile === "bluerov2-heavy-2024" ? "Optional BlueROV2 Heavy civilian reference · Ng 2024" : "Generic Fossen-style structure · synthetic coefficients"}</dd></div>
                <div><dt>ACTUATION BASIS</dt><dd>{config.dynamics.sixDof.parameters.actuationModel === "vectored-thrust" ? "Reduced vectored-thrust allocation" : "Generic control surfaces"}</dd></div>
                <div><dt>FIELD CALIBRATION</dt><dd>None</dd></div>
                <div><dt>LIVE SENSOR INTERFACE</dt><dd>None</dd></div>
              </dl>
              <p>This harness is suitable for synthetic algorithm comparison and software verification. It does not establish real-world vehicle or sensor performance.</p>
            </section>
            <section className="audit-panel panel">
              <div className="panel-title"><span>AUDIT AND REPRODUCIBILITY</span><span>REPLAY SCHEMA v2</span></div>
              <dl>
                <div><dt>ACTIVE CONFIGURATION</dt><dd>{activeConfigHash}</dd></div>
                <div><dt>SEED</dt><dd>{config.seed}</dd></div>
                <div><dt>RECORDED EVENTS</dt><dd>{view.replay.events}</dd></div>
                <div><dt>RECORDED FRAMES</dt><dd>{view.replay.frames}</dd></div>
                <div><dt>TELEMETRY SAMPLES</dt><dd>{view.replay.telemetrySamples}</dd></div>
                <div><dt>DETERMINISTIC CHECK</dt><dd>{verification ? (verification.deterministic ? "VERIFIED" : "DIVERGED") : "NOT RUN"}</dd></div>
              </dl>
              <p>Exported replays contain the frozen configuration, event sequence, timestamps, profiles, terminal result, and digest.</p>
            </section>
          </div>
        </section>
      )}

      <footer className="statusbar">
        <span>WORKER {view.ready ? `ONLINE / P${view.workerProtocolVersion}` : view.status.toUpperCase()}</span>
        <span>GEN {view.workerGeneration} / RECOVERY {view.workerRecoveries}</span>
        <span>SNAPSHOT {displaySnapshot?.sequence ?? "—"} @ 50 Hz</span>
        <span>TELEMETRY {displayTelemetry.length} SAMPLES @ 20 Hz</span>
        <span>DIAGNOSTIC TRUTH ERROR {estimatedError === null || estimatedError === undefined ? "—" : `${estimatedError.toFixed(1)} m`}</span>
        <span>NO LIVE INPUTS · SYNTHETIC MODEL · NOT OPERATIONALLY VALIDATED</span>
      </footer>
      {notice && <button className="notice" type="button" onClick={() => setNotice(null)}>{notice}</button>}
    </main>
  );
}

import type {
  DynamicsModel,
  GuidanceLaw,
  ObservationMode,
  ScenarioKind,
  SimulationConfig,
} from "../../sim/types";
import {
  applyHydrodynamicProfile,
  HYDRODYNAMIC_PROFILES,
  type HydrodynamicProfileId,
} from "../../sim/hydrodynamic-profiles";

interface Props {
  config: SimulationConfig;
  status: string;
  initialized: boolean;
  timeScale: number;
  showTruth: boolean;
  showDiagnostics: boolean;
  onConfig: (config: SimulationConfig) => void;
  onTimeScale: (scale: number) => void;
  onTruth: (value: boolean) => void;
  onDiagnostics: (value: boolean) => void;
  onRun: () => void;
  onPauseResume: () => void;
  onStep: () => void;
  onReset: () => void;
}

const radians = (value: number) => (value * Math.PI) / 180;
const degrees = (value: number) => (value * 180) / Math.PI;

function Choice<T extends string>({
  value,
  values,
  onChange,
  disabled = false,
}: {
  value: T;
  values: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segmented">
      {values.map((entry) => (
        <button
          type="button"
          className={value === entry.value ? "selected" : ""}
          key={entry.value}
          disabled={disabled}
          onClick={() => onChange(entry.value)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

function ParameterRow({
  label,
  value,
  unit,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></td>
      <td>{unit}</td>
    </tr>
  );
}

export function ControlPanel(props: Props) {
  const update = (mutate: (draft: SimulationConfig) => void) => {
    const next = structuredClone(props.config);
    mutate(next);
    props.onConfig(next);
  };
  const running = props.status === "running";
  const configLocked = running || props.status === "recovering";

  return (
    <aside className="control-panel panel">
      <div className="panel-title"><span>EXPERIMENT MANIFEST</span><span>{configLocked ? "LOCKED" : `REV ${props.config.version}`}</span></div>

      <fieldset disabled={configLocked}>
        <label>SENSOR INPUT</label>
        <Choice<ObservationMode>
          value={props.config.guidance.mode}
          values={[
            { value: "perfect", label: "TRUTH BASELINE" },
            { value: "raw", label: "RAW MEAS" },
            { value: "ekf", label: "EKF" },
          ]}
          onChange={(value) => update((draft) => { draft.guidance.mode = value; })}
          disabled={configLocked}
        />

        <label>MOTION MODEL</label>
        <Choice<DynamicsModel>
          value={props.config.dynamics.model}
          values={[
            { value: "planar-2.5d", label: "2.5D" },
            { value: "six-dof", label: "6-DOF" },
          ]}
          onChange={(value) => update((draft) => { draft.dynamics.model = value; })}
          disabled={configLocked}
        />

        <label>CONTROLLER</label>
        <Choice<GuidanceLaw>
          value={props.config.guidance.law}
          values={[
            { value: "pure-pursuit", label: "PURSUIT" },
            { value: "proportional-navigation", label: "PRO-NAV" },
          ]}
          onChange={(value) => update((draft) => { draft.guidance.law = value; })}
          disabled={configLocked}
        />

        <label>TRACKED-OBJECT SCENARIO</label>
        <select value={props.config.scenario.kind} onChange={(event) => update((draft) => { draft.scenario.kind = event.target.value as ScenarioKind; })}>
          <option value="constant-velocity">Constant velocity</option>
          <option value="constant-turn">Constant turn</option>
          <option value="scripted-evasive">Scripted maneuver</option>
        </select>

        <div className="config-section-title">RUN CONTROL</div>
        <table className="config-table">
          <tbody>
            <ParameterRow label="Random seed" value={props.config.seed} unit="—" min={0} step={1} onChange={(value) => update((draft) => { draft.seed = Math.max(0, Math.trunc(value)); })} />
            <tr>
              <th scope="row">Time scale</th>
              <td>
                <select value={props.timeScale} onChange={(event) => props.onTimeScale(Number(event.target.value))}>
                  {[0.25, 0.5, 1, 2, 4, 8].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </td>
              <td>×</td>
            </tr>
            <ParameterRow label="Rendezvous radius" value={props.config.interceptRadius} unit="m" min={0.1} step={0.1} onChange={(value) => update((draft) => { draft.interceptRadius = Math.max(0.1, value); })} />
          </tbody>
        </table>

        <details className="parameter-group" open>
          <summary>ESTIMATOR / SENSOR</summary>
          <table className="config-table">
            <tbody>
              <ParameterRow label="Navigation constant" value={props.config.guidance.navigationConstant} unit="—" min={1} max={6} step={0.1} onChange={(value) => update((draft) => { draft.guidance.navigationConstant = value; })} />
              <ParameterRow label="Bearing noise σ" value={Number(degrees(props.config.sensor.bearingSigma).toFixed(2))} unit="deg" min={0} max={20} step={0.1} onChange={(value) => update((draft) => { draft.sensor.bearingSigma = radians(value); })} />
              <ParameterRow label="Range noise base σ" value={props.config.sensor.rangeSigmaBase} unit="m" min={0} step={0.1} onChange={(value) => update((draft) => { draft.sensor.rangeSigmaBase = Math.max(0, value); })} />
              <ParameterRow label="Sensor cadence" value={props.config.sensor.cadenceHz} unit="Hz" min={0.1} step={0.1} onChange={(value) => update((draft) => { draft.sensor.cadenceHz = Math.max(0.1, value); })} />
              <ParameterRow label="Modeled latency" value={Number((props.config.sensor.latency * 1000).toFixed(1))} unit="ms" min={0} step={1} onChange={(value) => update((draft) => { draft.sensor.latency = Math.max(0, value / 1000); })} />
              <ParameterRow label="Half field-of-view" value={Number(degrees(props.config.sensor.fovHalfAngle).toFixed(1))} unit="deg" min={1} max={179} step={1} onChange={(value) => update((draft) => { draft.sensor.fovHalfAngle = radians(value); })} />
              <ParameterRow label="Dropout probability" value={Number((props.config.sensor.dropoutProbability * 100).toFixed(1))} unit="%" min={0} max={100} step={0.1} onChange={(value) => update((draft) => { draft.sensor.dropoutProbability = value / 100; })} />
              <ParameterRow label="Innovation gate" value={props.config.estimator.innovationGate} unit="NIS" min={0.1} step={0.01} onChange={(value) => update((draft) => { draft.estimator.innovationGate = Math.max(0.1, value); })} />
              <ParameterRow label="Track stale limit" value={props.config.estimator.staleAfter} unit="s" min={0.01} step={0.01} onChange={(value) => update((draft) => { draft.estimator.staleAfter = Math.max(0.01, value); })} />
            </tbody>
          </table>
        </details>

        {props.config.environment && props.config.acoustic && (
          <details className="parameter-group" open>
            <summary>SYNTHETIC ACOUSTIC CHANNEL</summary>
            <table className="config-table">
              <tbody>
                <tr>
                  <th scope="row">Channel model</th>
                  <td><select value={props.config.acoustic.enabled ? "enabled" : "disabled"} onChange={(event) => update((draft) => { if (draft.acoustic) draft.acoustic.enabled = event.target.value === "enabled"; })}><option value="enabled">Enabled</option><option value="disabled">Bypass</option></select></td>
                  <td>—</td>
                </tr>
                <ParameterRow label="Frequency" value={props.config.acoustic.frequencyKhz} unit="kHz" min={0.01} step={0.1} onChange={(value) => update((draft) => { if (draft.acoustic) draft.acoustic.frequencyKhz = Math.max(0.01, value); })} />
                <ParameterRow label="Synthetic source level" value={props.config.acoustic.sourceLevelDb} unit="dB" step={1} onChange={(value) => update((draft) => { if (draft.acoustic) draft.acoustic.sourceLevelDb = value; })} />
                <ParameterRow label="Synthetic target strength" value={props.config.acoustic.targetStrengthDb} unit="dB" step={1} onChange={(value) => update((draft) => { if (draft.acoustic) draft.acoustic.targetStrengthDb = value; })} />
                <ParameterRow label="Ambient noise level" value={props.config.acoustic.ambientNoiseDb} unit="dB" step={1} onChange={(value) => update((draft) => { if (draft.acoustic) draft.acoustic.ambientNoiseDb = value; })} />
                <ParameterRow label="Receiver directivity" value={props.config.acoustic.receiverDirectivityIndexDb} unit="dB" min={0} step={1} onChange={(value) => update((draft) => { if (draft.acoustic) draft.acoustic.receiverDirectivityIndexDb = Math.max(0, value); })} />
                <ParameterRow label="Detection threshold" value={props.config.acoustic.detectionThresholdDb} unit="dB" step={0.5} onChange={(value) => update((draft) => { if (draft.acoustic) draft.acoustic.detectionThresholdDb = value; })} />
                <ParameterRow label="Detection transition" value={props.config.acoustic.detectionTransitionDb} unit="dB" min={0.01} step={0.1} onChange={(value) => update((draft) => { if (draft.acoustic) draft.acoustic.detectionTransitionDb = Math.max(0.01, value); })} />
              </tbody>
            </table>
            <div className="table-subtitle">WATER-COLUMN ASSUMPTIONS</div>
            <table className="config-table">
              <tbody>
                <ParameterRow label="Temperature" value={props.config.environment.temperatureC} unit="°C" step={0.1} onChange={(value) => update((draft) => { if (draft.environment) draft.environment.temperatureC = value; })} />
                <ParameterRow label="Salinity" value={props.config.environment.salinityPsu} unit="PSU" min={0} step={0.1} onChange={(value) => update((draft) => { if (draft.environment) draft.environment.salinityPsu = Math.max(0, value); })} />
                <ParameterRow label="Water depth" value={props.config.environment.waterDepth} unit="m" min={1} step={1} onChange={(value) => update((draft) => { if (draft.environment) draft.environment.waterDepth = Math.max(1, value); })} />
                <ParameterRow label="Spreading coefficient" value={props.config.environment.spreadingCoefficient} unit="dB/dec" min={10} max={20} step={0.5} onChange={(value) => update((draft) => { if (draft.environment) draft.environment.spreadingCoefficient = value; })} />
              </tbody>
            </table>
            <p className="parameter-note">Analytic homogeneous-water approximation: Mackenzie sound speed, Thorp absorption, configurable spreading, and a synthetic active-echo link budget. No ray tracing or field calibration.</p>
          </details>
        )}

        <details className="parameter-group">
          <summary>INITIAL STATE · WORLD X–Z</summary>
          <div className="table-subtitle">OBSERVER VEHICLE</div>
          <table className="config-table">
            <tbody>
              <ParameterRow label="Position X" value={props.config.torpedo.initial.position.x} unit="m" step={1} onChange={(value) => update((draft) => { draft.torpedo.initial.position.x = value; })} />
              <ParameterRow label="Position Z" value={props.config.torpedo.initial.position.z} unit="m" step={1} onChange={(value) => update((draft) => { draft.torpedo.initial.position.z = value; })} />
              <ParameterRow label="Depth" value={props.config.torpedo.initial.depth} unit="m" min={0} step={1} onChange={(value) => update((draft) => { draft.torpedo.initial.depth = Math.max(0, value); draft.torpedo.initial.position.y = -draft.torpedo.initial.depth; })} />
              <ParameterRow label="Speed" value={props.config.torpedo.initial.speed} unit="m/s" min={0} step={0.1} onChange={(value) => update((draft) => { draft.torpedo.initial.speed = Math.max(0, value); })} />
              <ParameterRow label="Heading" value={Number(degrees(props.config.torpedo.initial.heading).toFixed(1))} unit="deg" step={1} onChange={(value) => update((draft) => { draft.torpedo.initial.heading = radians(value); })} />
            </tbody>
          </table>
          <div className="table-subtitle">TRACKED OBJECT</div>
          <table className="config-table">
            <tbody>
              <ParameterRow label="Position X" value={props.config.target.initial.position.x} unit="m" step={1} onChange={(value) => update((draft) => { draft.target.initial.position.x = value; })} />
              <ParameterRow label="Position Z" value={props.config.target.initial.position.z} unit="m" step={1} onChange={(value) => update((draft) => { draft.target.initial.position.z = value; })} />
              <ParameterRow label="Depth" value={props.config.target.initial.depth} unit="m" min={0} step={1} onChange={(value) => update((draft) => { draft.target.initial.depth = Math.max(0, value); draft.target.initial.position.y = -draft.target.initial.depth; })} />
              <ParameterRow label="Speed" value={props.config.target.initial.speed} unit="m/s" min={0} step={0.1} onChange={(value) => update((draft) => { draft.target.initial.speed = Math.max(0, value); })} />
              <ParameterRow label="Heading" value={Number(degrees(props.config.target.initial.heading).toFixed(1))} unit="deg" step={1} onChange={(value) => update((draft) => { draft.target.initial.heading = radians(value); })} />
            </tbody>
          </table>
        </details>

        {props.config.dynamics.model === "six-dof" && (
          <details className="parameter-group">
            <summary>HYDRODYNAMIC REFERENCE</summary>
            <label className="select-label">
              COEFFICIENT SET
              <select
                value={props.config.dynamics.sixDof.profile ?? "generic-fictional"}
                onChange={(event) => update((draft) => {
                  applyHydrodynamicProfile(draft, event.target.value as HydrodynamicProfileId);
                })}
              >
                {Object.values(HYDRODYNAMIC_PROFILES).map((profile) => (
                  <option value={profile.id} key={profile.id}>{profile.label}</option>
                ))}
              </select>
            </label>
            <p className="parameter-note">
              {HYDRODYNAMIC_PROFILES[props.config.dynamics.sixDof.profile ?? "generic-fictional"].basis}.
              The civilian profile uses published diagonal coefficients and a reduced vectored-thrust allocation;
              it is not a complete manufacturer digital twin.
            </p>
            <table className="config-table"><tbody>
              <ParameterRow label="Actuator lag scale" value={props.config.dynamics.sixDof.actuatorLagScale} unit="×" min={0.25} max={2.5} step={0.05} onChange={(value) => update((draft) => { draft.dynamics.sixDof.actuatorLagScale = value; })} />
              <ParameterRow label="Control authority" value={props.config.dynamics.sixDof.controlAuthorityScale} unit="×" min={0.5} max={1.75} step={0.05} onChange={(value) => update((draft) => { draft.dynamics.sixDof.controlAuthorityScale = value; })} />
            </tbody></table>
          </details>
        )}
      </fieldset>

      <details className="analysis-overlays">
        <summary>DIAGNOSTIC OVERLAYS</summary>
        <div className="toggle-grid">
          <label><input type="checkbox" checked={props.showTruth} onChange={(event) => props.onTruth(event.target.checked)} /> GROUND TRUTH · ANALYSIS ONLY</label>
          <label><input type="checkbox" checked={props.showDiagnostics} onChange={(event) => props.onDiagnostics(event.target.checked)} /> CPA / VELOCITY GEOMETRY</label>
        </div>
      </details>

      <div className="transport">
        <button className="run" type="button" onClick={props.onRun}>{props.initialized ? "REINITIALIZE RUN" : "INITIALIZE RUN"}</button>
        <button type="button" disabled={!props.initialized} onClick={props.onPauseResume}>{running ? "PAUSE" : "RESUME"}</button>
        <button type="button" disabled={!props.initialized || running} onClick={props.onStep}>SINGLE STEP · 5 ms</button>
        <button type="button" disabled={!props.initialized} onClick={props.onReset}>RESET</button>
      </div>
    </aside>
  );
}

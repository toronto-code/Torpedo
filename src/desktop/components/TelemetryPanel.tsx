import { orientationAngles } from "../../sim/quaternion";
import type { RenderSnapshot, SimulationConfig, VehicleState } from "../../sim/types";
import { classifyTrackQuality } from "../trackQuality";

interface Props {
  snapshot: RenderSnapshot | null;
  config: SimulationConfig;
}

const degrees = (radians: number) => (radians * 180) / Math.PI;

function value(number: number | null | undefined, digits = 1): string {
  return number === null || number === undefined || !Number.isFinite(number) ? "—" : number.toFixed(digits);
}

function Metric({ label, value: display, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{display}</strong>
      <small>{unit}</small>
    </div>
  );
}

function Evidence({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><span>{label}</span><strong>{children}</strong></div>;
}

function VehicleStateTable({ label, vehicle }: { label: string; vehicle: VehicleState }) {
  const attitude = orientationAngles(vehicle.orientation);
  return (
    <div className="vehicle-state">
      <div className="table-subtitle">{label}</div>
      <div className="metric-grid">
        <Metric label="NORTH" value={value(vehicle.position.x)} unit="m" />
        <Metric label="EAST" value={value(vehicle.position.y)} unit="m" />
        <Metric label="DEPTH" value={value(vehicle.depth)} unit="m" />
        <Metric label="SPEED" value={value(vehicle.speed)} unit="m/s" />
        <Metric label="VERTICAL SPEED" value={value(vehicle.depthRate, 2)} unit="m/s" />
        <Metric label="YAW" value={value(degrees(attitude.heading), 1)} unit="deg" />
        <Metric label="PITCH" value={value(degrees(attitude.pitch), 2)} unit="deg" />
        <Metric label="ROLL" value={value(degrees(attitude.roll), 2)} unit="deg" />
      </div>
    </div>
  );
}

export function TelemetryPanel({ snapshot, config }: Props) {
  const metrics = snapshot?.metrics;
  const estimate = snapshot?.estimate;
  const guidance = snapshot?.guidance;
  const observation = snapshot?.observation;
  const acoustic = snapshot?.acoustic;
  const attitude = snapshot ? orientationAngles(snapshot.torpedo.orientation) : null;
  const positionVariance = estimate
    ? Math.max(0, (estimate.covariance[0]?.[0] ?? 0) + (estimate.covariance[1]?.[1] ?? 0))
    : null;
  const positionTwoSigma = positionVariance === null ? null : 2 * Math.sqrt(positionVariance / 2);
  const quality = classifyTrackQuality({
    estimate: estimate ?? null,
    observationId: observation?.id,
    seekerStatus: snapshot?.seekerStatus,
    cadenceHz: config.sensor.cadenceHz,
  });
  const gateState = estimate?.observationAccepted === undefined
    ? "NO UPDATE"
    : estimate.observationAccepted ? "ACCEPTED" : "REJECTED";
  const latency = observation ? (observation.deliveredAt - observation.observedAt) * 1000 : null;

  return (
    <section className="telemetry-panel panel">
      <div className="panel-title">
        <span>TRACK SOLUTION</span>
        <span className={`track-quality ${quality.toLowerCase().replace(" ", "-")}`}>{quality}</span>
      </div>

      <div className="track-state-strip">
        <span>SENSOR <strong className={`lock-state ${snapshot?.seekerStatus ?? "searching"}`}>{snapshot?.seekerStatus ?? "WAITING"}</strong></span>
        <span>FILTER UPDATE <strong className={gateState.toLowerCase().replace(" ", "-")}>{gateState}</strong></span>
        <span>TRACK SOURCE <strong>{estimate?.source.toUpperCase() ?? "—"}</strong></span>
      </div>

      <div className="metric-grid">
        <Metric label="3D SEPARATION" value={value(metrics?.range)} unit="m" />
        <Metric label="HORIZONTAL SEPARATION" value={value(metrics?.horizontalRange)} unit="m" />
        <Metric label="DEPTH DIFFERENCE" value={value(metrics?.verticalSeparation)} unit="m" />
        <Metric label="RELATIVE BEARING" value={value(metrics ? degrees(metrics.relativeBearing) : null, 2)} unit="deg" />
        <Metric label="CLOSING RATE" value={value(metrics?.closingVelocity, 2)} unit="m/s" />
        <Metric label="LINE-OF-SIGHT RATE" value={value(metrics ? degrees(metrics.losRate) : null, 3)} unit="deg/s" />
        <Metric label="PREDICTED SEPARATION" value={value(metrics?.predictedMissDistance)} unit="m" />
        <Metric label="TIME TO CPA" value={value(metrics?.predictedTimeToCpa, 2)} unit="s" />
        <Metric label="CONTROLLER INPUT" value={value(guidance?.lateralAcceleration, 2)} unit="m/s²" />
        <Metric label="ACHIEVED YAW RATE" value={value(snapshot ? degrees(snapshot.torpedo.yawRate) : null, 2)} unit="deg/s" />
        <Metric label="TRACK AGE" value={value(estimate?.age, 3)} unit="s" />
        <Metric label="POSITION 2σ RMS" value={value(positionTwoSigma, 2)} unit="m" />
        <Metric label="INNOVATION NIS" value={value(estimate?.nis, 2)} unit={`/ ${config.estimator.innovationGate.toFixed(2)}`} />
        <Metric label="OBSERVER DEPTH" value={value(snapshot?.torpedo.depth, 1)} unit="m" />
        <Metric label="ROLL" value={value(attitude ? degrees(attitude.roll) : null, 2)} unit="deg" />
        <Metric label="PITCH" value={value(attitude ? degrees(attitude.pitch) : null, 2)} unit="deg" />
      </div>

      {snapshot && (
        <div className="vehicle-state-stack">
          <VehicleStateTable label="OBSERVER VEHICLE" vehicle={snapshot.torpedo} />
          <VehicleStateTable label="TRACKED OBJECT" vehicle={snapshot.target} />
        </div>
      )}

      <div className="track-vector">
        <span>ESTIMATED TRACK · NED HORIZONTAL</span>
        <code>
          P [{value(estimate?.position.x)}, {value(estimate?.position.y)}] m&nbsp;&nbsp;
          V [{value(estimate?.velocity.x, 2)}, {value(estimate?.velocity.y, 2)}] m/s
        </code>
      </div>

      <div className="evidence-title">MEASUREMENT PROVENANCE</div>
      <div className="evidence-grid">
        <Evidence label="OBSERVATION ID">{observation ? `M-${String(observation.id).padStart(5, "0")}` : "—"}</Evidence>
        <Evidence label="OBSERVED AT">{observation ? `T+${observation.observedAt.toFixed(3)} s` : "—"}</Evidence>
        <Evidence label="DELIVERED AT">{observation ? `T+${observation.deliveredAt.toFixed(3)} s` : "—"}</Evidence>
        <Evidence label="MODELED LATENCY">{latency === null ? "—" : `${latency.toFixed(1)} ms`}</Evidence>
        <Evidence label="BEARING INNOVATION">{estimate?.innovation ? `${degrees(estimate.innovation[0]).toFixed(3)} deg` : "—"}</Evidence>
        <Evidence label="RANGE INNOVATION">{estimate?.innovation ? `${estimate.innovation[1].toFixed(2)} m` : "—"}</Evidence>
        <Evidence label="SOUND SPEED">{acoustic ? `${acoustic.soundSpeed.toFixed(1)} m/s` : "BYPASSED"}</Evidence>
        <Evidence label="ABSORPTION">{acoustic ? `${acoustic.absorptionDbPerKm.toFixed(3)} dB/km` : "—"}</Evidence>
        <Evidence label="ONE-WAY TL">{acoustic ? `${acoustic.oneWayTransmissionLossDb.toFixed(2)} dB` : "—"}</Evidence>
        <Evidence label="RECEIVED ECHO">{acoustic ? `${acoustic.receivedEchoLevelDb.toFixed(2)} dB` : "—"}</Evidence>
        <Evidence label="CHANNEL SNR">{acoustic ? `${acoustic.signalToNoiseDb.toFixed(2)} dB` : "—"}</Evidence>
        <Evidence label="DETECTION PROBABILITY">{acoustic ? `${(acoustic.detectionProbability * 100).toFixed(1)}%` : "—"}</Evidence>
        <Evidence label="TWO-WAY PROPAGATION">{acoustic ? `${(acoustic.propagationDelay * 1000).toFixed(1)} ms` : "—"}</Evidence>
        <Evidence label="INPUT BUS">WORKER-SYNTHETIC / NO I/O</Evidence>
      </div>
    </section>
  );
}

import type {
  ReplayFile,
  ReplaySummary,
  ReplayVerification,
  RuntimeProfileSample,
} from "../../replay/types";

interface Props {
  summary: ReplaySummary;
  replay: ReplayFile | null;
  playback: boolean;
  frameIndex: number;
  verification: ReplayVerification | null;
  verifying: boolean;
  recoveries: number;
  profile: RuntimeProfileSample | null;
  onEnter: () => void;
  onExit: () => void;
  onFrame: (index: number) => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onVerify: () => void;
}

export function ReplayTimeline(props: Props) {
  const frameCount = props.replay?.frames.length ?? props.summary.frames;
  const maximum = Math.max(0, frameCount - 1);
  const activeFrame = props.replay?.frames[props.frameIndex];
  const duration = props.replay?.frames.at(-1)?.snapshot.timestamp ?? props.summary.duration;
  const factor = props.profile?.realTimeFactor;

  return (
    <section className={`replay-strip panel ${props.playback ? "playback" : "recording"}`}>
      <div className="replay-identity">
        <strong>{props.playback ? "REPLAY" : "REC"}</strong>
        <span>{frameCount} FRAMES</span>
        <span>{props.replay?.events.length ?? props.summary.events} EVENTS</span>
        <span>{duration.toFixed(3)} s</span>
      </div>

      <div className="timeline-control">
        <button
          type="button"
          disabled={!props.playback || props.frameIndex <= 0}
          onClick={() => props.onFrame(props.frameIndex - 1)}
          aria-label="Previous replay frame"
        >
          ◀
        </button>
        <input
          type="range"
          aria-label="Replay timeline"
          min="0"
          max={maximum}
          step="1"
          value={Math.min(props.frameIndex, maximum)}
          disabled={!props.playback || frameCount === 0}
          onChange={(event) => props.onFrame(Number(event.target.value))}
        />
        <button
          type="button"
          disabled={!props.playback || props.frameIndex >= maximum}
          onClick={() => props.onFrame(props.frameIndex + 1)}
          aria-label="Next replay frame"
        >
          ▶
        </button>
        <output>
          T+ {(activeFrame?.snapshot.timestamp ?? duration).toFixed(3)} / {duration.toFixed(3)}
        </output>
      </div>

      <div className="replay-actions">
        <button type="button" disabled={!props.summary.available && !props.replay} onClick={props.playback ? props.onExit : props.onEnter}>
          {props.playback ? "RETURN LIVE" : "ENTER REPLAY"}
        </button>
        <button type="button" disabled={!props.summary.available && !props.replay} onClick={props.onExport}>EXPORT</button>
        <label className="file-button">
          IMPORT
          <input
            type="file"
            aria-label="Import replay"
            accept="application/json,.json,.replay.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) props.onImport(file);
              event.target.value = "";
            }}
          />
        </label>
        <button type="button" disabled={!props.replay || !props.replay.result || props.verifying} onClick={props.onVerify}>
          {props.verifying ? "VERIFYING…" : "VERIFY"}
        </button>
      </div>

      <div className="replay-health">
        <span>RTF {factor === undefined ? "—" : `${factor.toFixed(2)}×`}</span>
        <span>RECOVERY {props.recoveries}</span>
        <span className={props.verification?.deterministic ? "verified" : ""}>
          {props.verification
            ? (props.verification.deterministic ? "DETERMINISTIC" : "DIVERGED")
            : "UNVERIFIED"}
        </span>
      </div>
    </section>
  );
}

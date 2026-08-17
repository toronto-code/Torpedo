import type { ReplayFile, ReplayFrame } from "./types";
import type { TelemetrySample } from "../sim/types";

export function clampFrameIndex(replay: ReplayFile, index: number): number {
  if (replay.frames.length === 0) return 0;
  return Math.min(replay.frames.length - 1, Math.max(0, Math.round(index)));
}

export function findFrameAtTime(replay: ReplayFile, timestamp: number): ReplayFrame | null {
  if (replay.frames.length === 0) return null;
  let low = 0;
  let high = replay.frames.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (replay.frames[middle].snapshot.timestamp <= timestamp + 1e-12) low = middle;
    else high = middle - 1;
  }
  return replay.frames[low];
}

export function telemetryThroughTime(
  replay: ReplayFile,
  timestamp: number,
): TelemetrySample[] {
  let low = 0;
  let high = replay.telemetry.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (replay.telemetry[middle].timestamp <= timestamp + 1e-12) low = middle + 1;
    else high = middle;
  }
  return replay.telemetry.slice(0, low);
}


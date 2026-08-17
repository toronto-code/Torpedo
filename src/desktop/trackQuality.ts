import type { SeekerStatus, TrackEstimate } from "../sim/types";

export type TrackQuality =
  | "NO TRACK"
  | "TENTATIVE"
  | "CONFIRMED"
  | "COASTING"
  | "STALE"
  | "REJECTED";

interface TrackQualityInput {
  estimate: TrackEstimate | null;
  observationId?: number;
  seekerStatus?: SeekerStatus;
  cadenceHz: number;
}

/** Presentation-only classification; it is never supplied to guidance or control. */
export function classifyTrackQuality(input: TrackQualityInput): TrackQuality {
  const { estimate } = input;
  if (!estimate) return "NO TRACK";
  if (!estimate.valid) return "STALE";
  if ((input.observationId ?? 2) < 2) return "TENTATIVE";
  const recentWindow = 1.25 / Math.max(0.1, input.cadenceHz);
  if (estimate.observationAccepted === false && estimate.age <= recentWindow) return "REJECTED";
  if (input.seekerStatus === "locked" && estimate.age <= recentWindow) return "CONFIRMED";
  return "COASTING";
}

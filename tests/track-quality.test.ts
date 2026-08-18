import { describe, expect, it } from "vitest";

import { classifyTrackQuality } from "../src/desktop/trackQuality";
import type { TrackEstimate } from "../src/sim/types";

function estimate(overrides: Partial<TrackEstimate> = {}): TrackEstimate {
  return {
    timestamp: 1,
    position: { x: 10, y: 20 },
    velocity: { x: 2, y: 1 },
    covariance: [
      [4, 0, 0, 0],
      [0, 4, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    age: 0.05,
    valid: true,
    source: "ekf",
    observationAccepted: true,
    ...overrides,
  };
}

describe("display-only track quality classification", () => {
  it("distinguishes tentative, confirmed, rejected, coasting, and stale tracks", () => {
    expect(classifyTrackQuality({ estimate: null, cadenceHz: 8 })).toBe("NO TRACK");
    expect(classifyTrackQuality({ estimate: estimate(), observationId: 1, seekerStatus: "locked", cadenceHz: 8 })).toBe("TENTATIVE");
    expect(classifyTrackQuality({ estimate: estimate(), observationId: 4, seekerStatus: "locked", cadenceHz: 8 })).toBe("CONFIRMED");
    expect(classifyTrackQuality({ estimate: estimate({ observationAccepted: false }), observationId: 4, seekerStatus: "locked", cadenceHz: 8 })).toBe("REJECTED");
    expect(classifyTrackQuality({ estimate: estimate({ age: 0.5 }), observationId: 4, seekerStatus: "dropout", cadenceHz: 8 })).toBe("COASTING");
    expect(classifyTrackQuality({ estimate: estimate({ age: 2, valid: false }), observationId: 4, seekerStatus: "dropout", cadenceHz: 8 })).toBe("STALE");
  });
});

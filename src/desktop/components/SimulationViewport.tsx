import { useEffect, useRef } from "react";

import type { RenderSnapshot } from "../../sim/types";
import {
  SimulationScene,
  type CameraMode,
  type SceneOptions,
} from "../scene/SimulationScene";

interface Props {
  snapshot: RenderSnapshot | null;
  cameraMode: CameraMode;
  showTruth: boolean;
  showDiagnostics: boolean;
  fovHalfAngle: number;
  replayHistory?: RenderSnapshot[];
}

export function SimulationViewport(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<SimulationScene | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const options: SceneOptions = {
      cameraMode: props.cameraMode,
      showTruth: props.showTruth,
      showDiagnostics: props.showDiagnostics,
      fovHalfAngle: props.fovHalfAngle,
    };
    scene.current = new SimulationScene(host.current, options);
    return () => {
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    scene.current?.setSnapshot(props.snapshot, Boolean(props.replayHistory));
    if (props.replayHistory) scene.current?.setReplayHistory(props.replayHistory);
  }, [props.replayHistory, props.snapshot]);

  useEffect(() => {
    scene.current?.setOptions({
      cameraMode: props.cameraMode,
      showTruth: props.showTruth,
      showDiagnostics: props.showDiagnostics,
      fovHalfAngle: props.fovHalfAngle,
    });
  }, [props.cameraMode, props.fovHalfAngle, props.showDiagnostics, props.showTruth]);

  return <div className="simulation-viewport" ref={host} />;
}

/// <reference lib="webworker" />

import { verifyReplay } from "../replay/verification";
import type { ReplayFile, ReplayVerification } from "../replay/types";

interface Request {
  replay: ReplayFile;
  tolerance?: number;
}

type Response =
  | { type: "result"; verification: ReplayVerification }
  | { type: "error"; message: string };

const context = self as DedicatedWorkerGlobalScope;

context.onmessage = (event: MessageEvent<Request>) => {
  try {
    const verification = verifyReplay(event.data.replay, event.data.tolerance);
    const response: Response = { type: "result", verification };
    context.postMessage(response);
  } catch (error) {
    const response: Response = {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    };
    context.postMessage(response);
  }
};


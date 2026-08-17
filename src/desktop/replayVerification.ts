import type { ReplayFile, ReplayVerification } from "../replay/types";

type Response =
  | { type: "result"; verification: ReplayVerification }
  | { type: "error"; message: string };

export function verifyReplayAsync(
  replay: ReplayFile,
  tolerance = 1e-9,
): Promise<ReplayVerification> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./replay.worker.ts", import.meta.url), {
      type: "module",
      name: "replay-verification",
    });
    worker.onmessage = (event: MessageEvent<Response>) => {
      worker.terminate();
      if (event.data.type === "result") resolve(event.data.verification);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage({ replay, tolerance });
  });
}

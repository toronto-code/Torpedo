import { createDefaultConfig } from "../src/sim/config";
import { runNumericalSoak } from "../src/replay/verification";
import type { DynamicsModel } from "../src/sim/types";

const equalsArgument = process.argv.find((argument) => argument.startsWith("--duration="));
const flagIndex = process.argv.indexOf("--duration");
const duration = equalsArgument
  ? Number(equalsArgument.split("=")[1])
  : flagIndex >= 0
    ? Number(process.argv[flagIndex + 1])
    : 600;
const dynamicsIndex = process.argv.indexOf("--dynamics");
const dynamics = (dynamicsIndex >= 0 ? process.argv[dynamicsIndex + 1] : "planar-2.5d") as DynamicsModel;
if (!Number.isFinite(duration) || duration <= 0) {
  throw new Error("--duration must be a positive number of simulated seconds.");
}
if (!["planar-2.5d", "six-dof"].includes(dynamics)) {
  throw new Error("--dynamics must be planar-2.5d or six-dof.");
}

const report = runNumericalSoak(() => {
  const config = createDefaultConfig();
  config.dynamics.model = dynamics;
  return config;
}, duration);
console.log(JSON.stringify(report, null, 2));
if (!report.finite || report.terminationReason === "invalid-state") process.exitCode = 1;

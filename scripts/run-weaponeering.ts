import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runWeaponeeringStudy } from "../src/analysis/weaponeering";
import { createDefaultConfig } from "../src/sim/config";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runs = Number(valueAfter(args, "--runs") ?? 8);
  const baseSeed = Number(valueAfter(args, "--seed") ?? 20260814);
  const outputDirectory = resolve(
    valueAfter(args, "--out") ?? "outputs/weaponeering",
  );
  const config = createDefaultConfig();
  config.weapon = {
    phases: { enableTime: 4, terminalRange: 400, reacquireAfter: 2 },
    speed: { cruiseSpeed: 30, sprintSpeed: 40 },
    endurance: { runTime: 90 },
    terminalSensor: { cadenceHz: 20, innovationGate: 6 },
    fuze: { detectionRadius: 18 },
    effectiveness: { lethalRadius: 12, shape: 2 },
  };
  const report = runWeaponeeringStudy({
    runs,
    baseSeed,
    createConfig: () => structuredClone(config),
  });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    resolve(outputDirectory, "weaponeering.json"),
    JSON.stringify(report, null, 2),
  );
  for (const variant of report.variants) {
    const line = [
      variant.label.padEnd(24),
      `det ${(variant.detonationRate * 100).toFixed(0)}%`,
      `int ${(variant.interceptRate * 100).toFixed(0)}%`,
      `exh ${(variant.exhaustionRate * 100).toFixed(0)}%`,
      `cpa ${variant.meanClosestApproach.toFixed(1)} m`,
      variant.meanEffectiveness !== null
        ? `eff ${variant.meanEffectiveness.toFixed(3)}`
        : "eff —",
    ].join("  ");
    console.log(line);
  }
  console.log(`Report written to ${outputDirectory}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

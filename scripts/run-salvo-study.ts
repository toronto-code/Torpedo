import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runSalvoStudy } from "../src/analysis/salvo-study";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runs = Number(valueAfter(args, "--runs") ?? 10);
  const baseSeed = Number(valueAfter(args, "--seed") ?? 20260814);
  const out = resolve(valueAfter(args, "--out") ?? "outputs/salvo-study");
  const report = runSalvoStudy({ runs, baseSeed });
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, "salvo-study.json"), JSON.stringify(report, null, 2));
  for (const variant of report.variants) {
    const line = [
      variant.id.padEnd(20),
      `mean shots ${variant.meanShots.toFixed(2)}`,
      `1-shot ${variant.oneShotKills}/${variant.runs}`,
      `2-shot ${variant.twoShotKills}/${variant.runs}`,
      `survivors ${variant.survivors}/${variant.runs}`,
    ].join("  ");
    console.log(line);
  }
  console.log(`Report written to ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

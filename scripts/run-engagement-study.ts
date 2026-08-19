import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runEngagementStudy } from "../src/analysis/engagement-study";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runs = Number(valueAfter(args, "--runs") ?? 6);
  const baseSeed = Number(valueAfter(args, "--seed") ?? 20260814);
  const out = resolve(valueAfter(args, "--out") ?? "outputs/engagement-study");
  const report = runEngagementStudy({ runs, baseSeed });
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, "engagement-study.json"), JSON.stringify(report, null, 2));
  for (const variant of report.variants) {
    const line = [
      variant.id.padEnd(22),
      `correct ${(variant.outcomes["correct-hostile"] / variant.runs * 100).toFixed(0)}%`,
      `seduced ${(variant.outcomes["decoy-seduction"] / variant.runs * 100).toFixed(0)}%`,
      `wrong ${(variant.outcomes["wrong-contact"] / variant.runs * 100).toFixed(0)}%`,
      `miss ${(variant.outcomes.miss / variant.runs * 100).toFixed(0)}%`,
      variant.meanTimeToAuthorize !== null ? `auth ${variant.meanTimeToAuthorize.toFixed(1)} s` : "auth —",
    ].join("  ");
    console.log(line);
  }
  console.log(`Report written to ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

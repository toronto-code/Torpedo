import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function run(executable: string, args: string[]): void {
  const result = spawnSync(executable, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} exited with status ${result.status}.`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const frames = resolve(valueAfter(args, "--frames") ?? "work/demo-frames");
  const outputDirectory = resolve(valueAfter(args, "--out") ?? "assets");
  const ffmpeg = valueAfter(args, "--ffmpeg") ?? "ffmpeg";
  const fps = Number(valueAfter(args, "--fps") ?? 10);
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("--fps must be positive.");
  const frameNames = (await readdir(frames))
    .filter((name) => /^frame-\d{4}\.png$/.test(name))
    .sort();
  if (frameNames.length === 0) throw new Error(`No demo frames found in ${frames}.`);
  const firstFrame = await readFile(resolve(frames, frameNames[0]));
  const isJpeg = firstFrame[0] === 0xff && firstFrame[1] === 0xd8;
  const isPng = firstFrame.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isJpeg && !isPng) throw new Error("Demo frames must contain PNG or JPEG image data.");
  if (ffmpeg.includes("/")) await access(ffmpeg);
  await mkdir(outputDirectory, { recursive: true });
  const input = resolve(frames, "frame-%04d.png");
  const mp4 = resolve(outputDirectory, "guidance-estimation-demo.mp4");
  const gif = resolve(outputDirectory, "guidance-estimation-demo.gif");
  const palette = resolve(frames, "palette.png");
  const inputOptions = ["-framerate", String(fps), ...(isJpeg ? ["-c:v", "mjpeg"] : []), "-i", input];
  run(ffmpeg, [
    "-y", ...inputOptions,
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", "libx264", "-preset", "slow", "-crf", "20",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4,
  ]);
  run(ffmpeg, [
    "-y", ...inputOptions,
    "-vf", "fps=8,scale=800:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff",
    palette,
  ]);
  run(ffmpeg, [
    "-y", ...inputOptions, "-i", palette,
    "-lavfi", "fps=8,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
    "-loop", "0", gif,
  ]);
  run(ffmpeg, [
    "-y", ...(isJpeg ? ["-c:v", "mjpeg"] : []),
    "-i", resolve(frames, frameNames[Math.floor(frameNames.length * 0.72)]),
    "-frames:v", "1", resolve(outputDirectory, "guidance-estimation-demo-poster.png"),
  ]);
  console.log(`Encoded ${frameNames.length} frames to ${mp4} and ${gif}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

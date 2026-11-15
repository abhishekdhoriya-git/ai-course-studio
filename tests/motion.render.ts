import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StudioApp } from "../src/app.js";
import { artifactSchemas } from "../src/domain/schemas.js";
import { renderManifestSchema } from "../src/media/contracts.js";
import { createSceneMotionPlan } from "../src/media/motion.js";
import { MediaTools, runMediaTool } from "../src/media/tools.js";

const execute = promisify(execFile);
const app = await StudioApp.open({ dataDirectory: ".studio\\verification" });
try {
  const record = app.store.latestArtifact("fixture:render-manifest");
  const output = app.store.latestArtifact("fixture:output");
  if (!record || !output || !app.store.isCurrent(output)) throw new Error("Render the current animated engineering fixture before checking decoded motion.");
  const manifest = renderManifestSchema.parse(artifactSchemas["workflow-report"].parse(record.content).data["renderManifest"]);
  const media = artifactSchemas.asset.parse(app.store.getArtifact(artifactSchemas["lesson-output"].parse(output.content).media).content);
  const file = join(app.root, ...media.path.split(/[\\/]/));
  const tools = new MediaTools();
  const folder = join(app.root, ".studio", "quality", "animation");
  mkdirSync(folder, { recursive: true });
  const checks: { sceneId: string; beforeFrame: number; afterFrame: number; region: number[]; meanPixelChange: number; beforeLightPixels: number; afterLightPixels: number }[] = [];
  let from = 0;
  for (const scene of manifest.scenes) {
    assert(scene.wordTimings?.length, "The actual animation must use measured word events, not estimated reading speed.");
    const plan = createSceneMotionPlan(scene, manifest.fps);
    const selected = plan.layout === "intro" ? { beat: plan.points[0]!, region: [72, 357, 720, 58] }
      : plan.layout === "gates" ? { beat: plan.cards[3]!, region: [942, 235, 266, 198] }
      : plan.layout === "revision" ? { beat: plan.nodes[1]!, region: [354, 231, 184, 100] }
      : { beat: plan.fourth, region: [1066, 300, 112, 84] };
    const beforeFrame = Math.max(0, selected.beat.frame - 2);
    const afterFrame = selected.beat.frame + plan.revealFrames + 2;
    const buffers: Buffer[] = [];
    for (const [label, frame] of [["before", beforeFrame], ["after", afterFrame]] as const) {
      const time = (from + frame) / manifest.fps;
      const [x, y, width, height] = selected.region;
      const result = await execute(tools.ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", file, "-frames:v", "1",
        "-vf", `crop=${width}:${height}:${x}:${y},format=rgb24`, "-f", "rawvideo", "pipe:1",
      ], { encoding: "buffer", windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
      buffers.push(result.stdout);
      await runMediaTool(tools.ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y", "-ss", String(time), "-i", file,
        "-frames:v", "1", join(folder, `animated-${scene.id}-${label}.png`),
      ]);
    }
    const before = buffers[0]!; const after = buffers[1]!;
    assert.equal(before.length, after.length);
    const lightPixels = (pixels: Buffer) => {
      let light = 0;
      for (let index = 0; index < pixels.length; index += 3) {
        if (pixels[index]! > 170 && pixels[index + 1]! > 170 && pixels[index + 2]! > 170) light++;
      }
      return light;
    };
    let difference = 0;
    for (let index = 0; index < before.length; index++) difference += Math.abs(before[index]! - after[index]!);
    const meanPixelChange = difference / before.length;
    const beforeLightPixels = lightPixels(before); const afterLightPixels = lightPixels(after);
    // These are teaching-block crops: neither subtitle changes nor the global header can satisfy this check.
    assert(beforeLightPixels < 10, `${scene.id}: future content is visible before its narration beat.`);
    assert(afterLightPixels > 50, `${scene.id}: revealed teaching text is missing from the actual MP4.`);
    assert(meanPixelChange > 5, `${scene.id}: the actual block remained effectively static.`);
    checks.push({ sceneId: scene.id, beforeFrame, afterFrame, region: selected.region, meanPixelChange, beforeLightPixels, afterLightPixels });
    from += scene.durationFrames;
  }
  const result = { outputVersion: output.version, template: manifest.template, excludesHeaderAndCaptions: true, checks };
  writeFileSync(join(folder, "decoded-motion-checks.json"), JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result, null, 2));
} finally { await app.close(); }

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { z } from "zod";
import { MissingInputError, StudioError } from "../domain/errors.js";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
export async function runMediaTool(command: string, args: string[], options: {
  signal?: AbortSignal; cwd?: string; timeout?: number;
} = {}): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execute(command, args, {
      encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      timeout: options.timeout ?? 120000,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new MissingInputError("MEDIA_TOOL_MISSING", `Install the required local tool: ${basename(command)}`);
    }
    const detail = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim().slice(-4000) : error instanceof Error ? error.message : "Unknown media failure";
    throw new StudioError("MEDIA_TOOL_FAILED", `${basename(command)} failed: ${detail}`);
  }
}
const probeSchema = z.object({
  streams: z.array(z.object({
    codec_type: z.string(), codec_name: z.string().optional(),
    width: z.number().optional(), height: z.number().optional(), r_frame_rate: z.string().optional(),
  }).passthrough()),
  format: z.object({ duration: z.string() }).passthrough(),
}).passthrough();
export type Probe = z.infer<typeof probeSchema>;
export function validateFixtureVideo(probe: Probe, expectedDurationMs: number): { durationMs: number; video: Probe["streams"][number] } {
  const videos = probe.streams.filter((stream) => stream.codec_type === "video");
  const audio = probe.streams.filter((stream) => stream.codec_type === "audio");
  const video = videos[0];
  const durationMs = Number(probe.format.duration) * 1000;
  const rate = video?.r_frame_rate?.split("/").map(Number);
  const fps = rate?.length === 2 ? rate[0]! / rate[1]! : Number.NaN;
  if (videos.length !== 1 || !video || video.width !== 1280 || video.height !== 720 || video.codec_name !== "h264"
    || audio.length !== 1 || audio[0]?.codec_name !== "aac" || fps !== 24
    || !Number.isFinite(durationMs) || Math.abs(durationMs - expectedDurationMs) > 100) {
    throw new StudioError("VIDEO_VALIDATION", "Both fixture exports must be 1280x720 at 24 fps, H.264/AAC, one video/audio stream and within 100 ms of measured frame duration.");
  }
  return { durationMs, video };
}

export class MediaTools {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  constructor() {
    const ffmpeg: unknown = require("ffmpeg-static");
    const ffprobe = z.object({ path: z.string() }).passthrough().parse(require("ffprobe-static"));
    if (typeof ffmpeg !== "string" || !existsSync(ffmpeg) || !existsSync(ffprobe.path)) {
      throw new MissingInputError("MEDIA_BINARIES_MISSING", "Restore the declared FFmpeg/ffprobe packages and approve their pinned installers.");
    }
    this.ffmpeg = ffmpeg; this.ffprobe = ffprobe.path;
  }
  async probe(file: string, signal?: AbortSignal): Promise<Probe> {
    const result = await runMediaTool(this.ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", basename(file)], {
      cwd: dirname(file), ...(signal ? { signal } : {}),
    });
    const probe = probeSchema.parse(JSON.parse(result.stdout) as unknown);
    if (!(Number(probe.format.duration) > 0)) throw new StudioError("MEDIA_DURATION", "The media has no measurable positive duration.");
    return probe;
  }
  async durationMs(file: string, signal?: AbortSignal): Promise<number> {
    return Number((await this.probe(file, signal)).format.duration) * 1000;
  }
  async decode(file: string, signal?: AbortSignal): Promise<void> {
    await runMediaTool(this.ffmpeg, ["-hide_banner", "-v", "error", "-xerror", "-i", file, "-f", "null", "-"], signal ? { signal } : {});
  }
  async normalizeAudio(input: string, output: string, signal?: AbortSignal): Promise<void> {
    await runMediaTool(this.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y", "-i", input,
      "-af", "loudnorm=I=-18:TP=-2:LRA=7", "-ar", "48000", "-ac", "1", output,
    ], signal ? { signal } : {});
  }
  async loudness(file: string, signal?: AbortSignal): Promise<{ integratedLufs: number; truePeakDb: number }> {
    const { stderr } = await runMediaTool(this.ffmpeg, [
      "-hide_banner", "-i", file, "-af", "loudnorm=I=-18:TP=-2:LRA=7:print_format=json", "-f", "null", "-",
    ], signal ? { signal } : {});
    const matches = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g);
    const last = matches?.at(-1);
    if (!last) throw new StudioError("AUDIO_MEASUREMENT", "FFmpeg returned no loudness/peak measurement.");
    const result = z.object({ input_i: z.string(), input_tp: z.string() }).passthrough().parse(JSON.parse(last) as unknown);
    const integratedLufs = Number(result.input_i); const truePeakDb = Number(result.input_tp);
    if (!Number.isFinite(integratedLufs) || !Number.isFinite(truePeakDb)) throw new StudioError("AUDIO_SILENT", "The final media contains no measurable speech.");
    return { integratedLufs, truePeakDb };
  }
  async longSilences(file: string, signal?: AbortSignal): Promise<number> {
    const { stderr } = await runMediaTool(this.ffmpeg, [
      "-hide_banner", "-i", file, "-af", "silencedetect=noise=-45dB:d=2", "-f", "null", "-",
    ], signal ? { signal } : {});
    return (stderr.match(/silence_duration:/g) ?? []).length;
  }
  async version(): Promise<string> {
    return (await runMediaTool(this.ffmpeg, ["-version"])).stdout.split(/\r?\n/)[0]!;
  }
}

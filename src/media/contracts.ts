import { z } from "zod";
import { artifactRefSchema, relativePathSchema } from "../domain/schemas.js";

export const FIXTURE_VIDEO_ID = "engineering-fixture";
export const FIXTURE_MANIFEST_ID = "fixture:manifest";
export const fixturePlanSchema = z.object({
  fixture: z.literal(true), version: z.literal("1.0.0"), videoId: z.literal(FIXTURE_VIDEO_ID),
  title: z.string(), disclosure: z.literal("ENGINEERING FIXTURE / NON-CLONED PRESENTER & VOICE"),
  width: z.literal(1280), height: z.literal(720), fps: z.literal(24),
  curriculum: artifactRefSchema, lesson: artifactRefSchema, storyboard: artifactRefSchema,
  style: artifactRefSchema, styleSample: artifactRefSchema, scenes: z.array(artifactRefSchema).length(4),
  poster: artifactRefSchema,
}).strict();
export type FixturePlan = z.infer<typeof fixturePlanSchema>;

export const speechBoundarySchema = z.object({
  text: z.string().min(1), startMs: z.number().nonnegative(),
  characterPosition: z.number().int().nonnegative(), characterCount: z.number().int().positive(),
}).strict();
export const speechResultSchema = z.object({
  voice: z.string().min(1), text: z.string().min(1),
  boundaries: z.array(speechBoundarySchema).min(1),
}).strict();
export type SpeechResult = z.infer<typeof speechResultSchema>;
export interface CaptionCue { startMs: number; endMs: number; text: string }
export interface RenderScene {
  id: string; title: string; purpose: string; script: string; layout: "intro" | "gates" | "revision" | "skills";
  durationFrames: number; audioPath: string; captions: CaptionCue[];
  wordTimings?: { text: string; startMs: number }[] | undefined;
}
export interface RenderManifest {
  fixture: true; title: string; width: number; height: number; fps: number;
  disclosure: string; scenes: RenderScene[]; burnInCaptions?: boolean;
  template?: { version: string; sourceHash: string } | undefined;
}
export const renderManifestSchema = z.object({
  fixture: z.literal(true), title: z.string().min(1), width: z.literal(1280), height: z.literal(720), fps: z.literal(24),
  disclosure: z.literal("ENGINEERING FIXTURE / NON-CLONED PRESENTER & VOICE"),
  burnInCaptions: z.boolean().default(false),
  template: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  scenes: z.array(z.object({
    id: z.string().min(1), title: z.string().min(1), purpose: z.string().min(1), script: z.string().min(1),
    layout: z.enum(["intro", "gates", "revision", "skills"]), durationFrames: z.number().int().positive(),
    audioPath: z.string().regex(/^audio\/[a-f0-9]{64}\.wav$/),
    captions: z.array(z.object({ startMs: z.number().nonnegative(), endMs: z.number().positive(), text: z.string().min(1) }).strict()).min(1),
    wordTimings: z.array(z.object({ text: z.string().min(1), startMs: z.number().nonnegative() }).strict()).min(1).optional(),
  }).strict()).length(4),
}).strict();

export const mediaCheckSchema = z.object({
  playable: z.literal(true), width: z.number().int().positive(), height: z.number().int().positive(),
  durationMs: z.number().positive(), expectedDurationMs: z.number().positive(),
  audioStreams: z.number().int().positive(), videoStreams: z.number().int().positive(),
  integratedLufs: z.number().finite(), truePeakDb: z.number().finite(),
  subtitleCueCount: z.number().int().positive(), renderMs: z.number().nonnegative(),
  silenceOver2sCount: z.number().int().nonnegative(),
  mediaPath: relativePathSchema, captionedPath: relativePathSchema,
  transcriptPath: relativePathSchema, srtPath: relativePathSchema, vttPath: relativePathSchema,
  nonCloned: z.literal(true), speechEngine: z.string().min(1), remotionVersion: z.literal("4.0.539"),
  ffmpegVersion: z.string().min(1),
  templateVersion: z.string().optional(), templateHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type MediaCheck = z.infer<typeof mediaCheckSchema>;

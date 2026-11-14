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
}
export interface RenderManifest {
  fixture: true; title: string; width: number; height: number; fps: number;
  disclosure: string; scenes: RenderScene[];
}

export const mediaCheckSchema = z.object({
  playable: z.literal(true), width: z.number().int().positive(), height: z.number().int().positive(),
  durationMs: z.number().positive(), expectedDurationMs: z.number().positive(),
  audioStreams: z.number().int().positive(), videoStreams: z.number().int().positive(),
  integratedLufs: z.number().finite(), truePeakDb: z.number().finite(),
  subtitleCueCount: z.number().int().positive(), renderMs: z.number().nonnegative(),
  mediaPath: relativePathSchema, captionedPath: relativePathSchema,
  transcriptPath: relativePathSchema, srtPath: relativePathSchema, vttPath: relativePathSchema,
  nonCloned: z.literal(true), speechEngine: z.string().min(1), remotionVersion: z.literal("4.0.539"),
  ffmpegVersion: z.string().min(1),
}).strict();
export type MediaCheck = z.infer<typeof mediaCheckSchema>;

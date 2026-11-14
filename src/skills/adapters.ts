import { z } from "zod";
import { artifactKindSchema, artifactRefSchema, jsonSchema } from "../domain/schemas.js";
import type { Json } from "../domain/schemas.js";

export interface SkillAdapterContext {
  jobId: string; stageId: string; invocationKey: string; attempt: number; signal?: AbortSignal;
}
export interface LocalSkillAdapter {
  id: string; version: string; inputSchemaId: string; outputSchemaId: string;
  activityKeys: readonly string[];
  effect: "local-pure";
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  execute(input: unknown, context: SkillAdapterContext): unknown | Promise<unknown>;
}
export function typedLocalAdapter<I, O>(definition: {
  id: string; version: string; inputSchemaId: string; outputSchemaId: string;
  activityKeys: readonly string[];
  input: z.ZodType<I>; output: z.ZodType<O>;
  execute(input: I, context: SkillAdapterContext): O | Promise<O>;
}): LocalSkillAdapter {
  return {
    id: definition.id, version: definition.version,
    inputSchemaId: definition.inputSchemaId, outputSchemaId: definition.outputSchemaId,
    activityKeys: definition.activityKeys,
    effect: "local-pure", inputSchema: definition.input, outputSchema: definition.output,
    execute: (input, context) => definition.execute(definition.input.parse(input), context),
  };
}

export const artifactReviewInputSchema = z.object({
  subject: z.string().min(1),
  artifacts: z.array(z.object({
    ref: artifactRefSchema, kind: artifactKindSchema, current: z.boolean(),
  }).strict()).max(1000),
}).strict();
export const artifactReviewOutputSchema = z.object({
  checked: z.number().int().nonnegative(),
  issues: z.array(z.object({
    code: z.enum(["NO_INPUTS", "STALE_ARTIFACT"]), artifactId: z.string().nullable(),
  }).strict()),
  humanReviewRequired: z.literal(true),
}).strict();
export const reviewArtifactsAdapter = typedLocalAdapter({
  id: "studio.review-artifacts", version: "1.0.0",
  activityKeys: ["review-artifacts", "review-scene"],
  inputSchemaId: "studio.artifact-review.input@1", outputSchemaId: "studio.artifact-review.output@1",
  input: artifactReviewInputSchema, output: artifactReviewOutputSchema,
  execute: (input) => ({
    checked: input.artifacts.length,
    issues: input.artifacts.length === 0
      ? [{ code: "NO_INPUTS" as const, artifactId: null }]
      : input.artifacts.filter((artifact) => !artifact.current)
        .map((artifact) => ({ code: "STALE_ARTIFACT" as const, artifactId: artifact.ref.id })),
    humanReviewRequired: true as const,
  }),
});
export const builtinSkillAdapters: readonly LocalSkillAdapter[] = [reviewArtifactsAdapter];

export function validatedAdapterOutput(adapter: LocalSkillAdapter, value: unknown): Json {
  return jsonSchema.parse(adapter.outputSchema.parse(value));
}

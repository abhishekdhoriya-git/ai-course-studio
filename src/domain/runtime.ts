import { z } from "zod";
import { artifactKindSchema, artifactRefSchema, approvalGateSchema, jsonSchema, keySchema, versionSchema } from "./schemas.js";
import type { ArtifactRef, Json } from "./schemas.js";

export const skillPinSchema = z.object({
  name: keySchema, version: versionSchema, documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  packageHash: z.string().regex(/^[a-f0-9]{64}$/), promptOnly: z.boolean(),
  adapterId: z.string().nullable(), adapterVersion: z.string().nullable(),
}).strict();
export type SkillPin = z.infer<typeof skillPinSchema>;
export const workflowIds = [
  "course-planning", "style-calibration", "lesson-production", "presenter-enrollment",
  "targeted-revision", "skill-maintenance", "course-batch",
] as const;
export type WorkflowId = typeof workflowIds[number];
export const activityBatchSchema = z.object({
  videoId: keySchema, activityKey: keySchema, workItemIds: z.array(keySchema).max(1000),
  skillName: keySchema.optional(),
}).strict();
export type ActivityBatch = z.infer<typeof activityBatchSchema>;
export const jobInputSchema = z.object({
  artifacts: z.array(artifactRefSchema).max(1000).default([]),
  activities: z.array(activityBatchSchema).max(100).default([]),
  videoId: keySchema.optional(),
  parameters: z.record(z.string(), jsonSchema).default({}),
}).strict();
export type JobInput = z.output<typeof jobInputSchema>;
export type JobInputRequest = z.input<typeof jobInputSchema>;

export const stageDefinitionSchema = z.object({
  id: keySchema,
  dependsOn: z.array(keySchema),
  inputSchema: z.literal("studio.stage-input@1"),
  outputSchema: z.literal("studio.stage-output@1"),
  adapter: z.object({ id: keySchema, version: versionSchema }).strict(),
  skill: keySchema.optional(),
  operation: keySchema,
  requirements: z.array(z.object({
    kind: artifactKindSchema, gate: approvalGateSchema.optional(),
  }).strict()),
  approvalGates: z.array(approvalGateSchema),
  invalidationDependencies: z.array(keySchema),
  retry: z.object({
    maxAttempts: z.number().int().min(1).max(5),
    initialBackoffMs: z.number().int().min(0).max(60000),
    maxBackoffMs: z.number().int().min(0).max(60000),
    multiplier: z.number().min(1).max(4),
    retryable: z.tuple([z.literal("transient")]),
  }).strict(),
  timeoutMs: z.number().int().min(1).max(300000),
  missingInput: z.string().min(1),
}).strict();
export type StageDefinition = z.infer<typeof stageDefinitionSchema>;
export const workflowDefinitionSchema = z.object({
  id: keySchema, version: versionSchema, description: z.string().min(1),
  stages: z.array(stageDefinitionSchema).min(1).max(50),
  maxQueued: z.number().int().min(1).max(100),
  maxConcurrency: z.number().int().min(1).max(4),
}).strict().superRefine((definition, context) => {
  const seen = new Set<string>();
  for (const stage of definition.stages) {
    if (seen.has(stage.id) || stage.dependsOn.some((id) => !seen.has(id))) {
      context.addIssue({ code: "custom", message: "Stage IDs must be unique and dependencies must precede their consumers" });
    }
    seen.add(stage.id);
  }
  if (!definition.stages.some((stage) => stage.skill)) {
    context.addIssue({ code: "custom", message: "A workflow must invoke a registered skill" });
  }
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export type JobStatus = "queued" | "running" | "paused" | "retry-wait" | "completed" | "failed" | "cancelled";
export type StageStatus = "pending" | "running" | "paused" | "retry-wait" | "completed" | "failed" | "cancelled" | "invalidated";
export interface StageRecord {
  id: string; status: StageStatus; attempts: number; nextAttemptAt: number | null;
  outputs: ArtifactRef[]; error: string | null; errorCode: string | null;
}
export interface JobRecord {
  id: string; workflowId: string; workflowVersion: string; definitionHash: string;
  definition: WorkflowDefinition; input: JobInput; skillPins: SkillPin[];
  status: JobStatus; reason: string | null; createdAt: number; updatedAt: number;
  leaseToken: string | null; leaseUntil: number | null; nextAttemptAt: number | null;
  stages: StageRecord[]; parentJobId: string | null;
}
export interface StageInput {
  jobId: string; stageId: string; artifacts: ArtifactRef[];
  parameters: Record<string, Json>; videoId?: string | undefined;
}
export const stageInputSchema = z.object({
  jobId: keySchema, stageId: keySchema, artifacts: z.array(artifactRefSchema),
  parameters: z.record(z.string(), jsonSchema), videoId: keySchema.optional(),
}).strict();
export const stageOutputSchema = z.object({
  summary: z.string().min(1),
  references: z.array(artifactRefSchema).default([]),
  artifacts: z.array(z.object({
    key: keySchema, kind: artifactKindSchema, content: jsonSchema,
    dependencies: z.array(artifactRefSchema).optional(),
  }).strict()).default([]),
}).strict();
export type StageOutput = z.output<typeof stageOutputSchema>;
export type StageOutputRequest = z.input<typeof stageOutputSchema>;

export type ProviderOperationState = "prepared" | "dispatching" | "uncertain" | "submitted" | "completed" | "failed";
export interface ProviderOperation {
  key: string; provider: string; idempotencyKey: string; requestHash: string;
  mode: "disabled" | "test" | "production";
  state: ProviderOperationState; remoteJobId: string | null; result: Json | null;
  error: string | null; createdAt: number; updatedAt: number;
}

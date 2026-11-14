import { z } from "zod";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(jsonSchema), z.record(z.string(), jsonSchema),
]));

export const keySchema = z.string().trim().min(1).max(240);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
export const relativePathSchema = z.string().min(1).refine(
  (value) => !/^(?:[a-zA-Z]:|[\\/])/.test(value)
    && !/[:\u0000-\u001f]/.test(value)
    && !value.split(/[\\/]/).some((part) => part === ".." || part === ""),
  "Use a repository-relative path without traversal",
);
export const artifactRefSchema = z.object({
  id: keySchema, version: z.number().int().positive(), hash: hashSchema,
}).strict();
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export const approvalGateSchema = z.enum([
  "curriculum", "style", "lesson", "script-storyboard", "provider", "identity-data",
  "spend", "presenter-sample", "first-lesson", "fixture-review", "skill-review", "publication",
]);
export type ApprovalGate = z.infer<typeof approvalGateSchema>;

const sourceSchema = z.object({
  url: z.url(), retrievedAt: z.iso.datetime(), title: z.string().min(1),
  supports: z.array(z.string().min(1)).min(1),
  uncertainty: z.string(), rights: z.string().min(1),
}).strict();
const briefSchema = z.object({
  title: z.string().min(1), niche: z.string().min(1), audience: z.string().min(1),
  language: z.string().min(1), prerequisites: z.array(z.string()),
  objectives: z.array(z.string().min(1)).min(1),
}).strict();
const evidenceSchema = z.object({
  sources: z.array(sourceSchema).min(1),
  accessGaps: z.array(z.string()),
  claims: z.array(z.object({ claim: z.string().min(1), sourceUrls: z.array(z.url()).min(1) }).strict()),
}).strict();
const curriculumSchema = z.object({
  title: z.string().min(1), brief: artifactRefSchema, evidence: artifactRefSchema,
  lessons: z.array(z.object({
    id: keySchema, title: z.string().min(1), objective: z.string().min(1),
    prerequisites: z.array(keySchema),
  }).strict()).min(1),
}).strict();
const lessonSchema = z.object({
  courseId: keySchema, videoId: keySchema, title: z.string().min(1),
  objective: z.string().min(1), curriculum: artifactRefSchema,
}).strict();
const sceneSchema = z.object({
  videoId: keySchema, sceneId: keySchema, purpose: z.string().min(1),
  script: z.string().min(1), visual: z.string().min(1),
  assets: z.array(artifactRefSchema),
  activities: z.array(keySchema).default([]),
}).strict();
const storyboardSchema = z.object({
  lesson: artifactRefSchema, evidence: artifactRefSchema,
  scenes: z.array(sceneSchema).min(1),
}).strict();
const assetSchema = z.object({
  path: relativePathSchema, sha256: hashSchema, mediaType: z.string().min(1),
  provenance: z.string().min(1), rights: z.string().min(1),
  fixture: z.boolean(),
}).strict();
const audioSchema = z.object({
  sceneId: keySchema, asset: artifactRefSchema, durationMs: z.number().positive(),
  measured: z.literal(true), transcript: z.string().min(1), fixture: z.boolean(),
}).strict();
const timingSchema = z.object({
  sceneId: keySchema, audio: artifactRefSchema,
  segments: z.array(z.object({
    startMs: z.number().nonnegative(), endMs: z.number().positive(), text: z.string().min(1),
  }).strict().refine((segment) => segment.endMs > segment.startMs, "Invalid timing bounds")).min(1),
}).strict();
const captionsSchema = z.object({
  sceneId: keySchema, audio: artifactRefSchema, timing: artifactRefSchema,
  asset: artifactRefSchema,
}).strict();
const compositionSchema = z.object({
  videoId: keySchema, scenes: z.array(artifactRefSchema).min(1),
  audio: z.array(artifactRefSchema).min(1), captions: z.array(artifactRefSchema),
  style: artifactRefSchema,
}).strict();
const styleSpecSchema = z.object({
  origin: z.enum(["original", "observed"]),
  observations: z.array(z.string()), proposals: z.array(z.string()).min(1),
  authorizedReferences: z.array(artifactRefSchema),
  parameters: z.record(z.string(), jsonSchema),
}).strict().refine(
  (style) => style.origin !== "observed" || (style.authorizedReferences.length > 0 && style.observations.length > 0),
  "Observed style requires actual authorized references and observations",
);
const sampleSchema = z.object({
  asset: artifactRefSchema, fixture: z.boolean(), notes: z.string().min(1),
}).strict();
const stylePackSchema = z.object({
  specification: artifactRefSchema, sample: artifactRefSchema,
  templateVersion: versionSchema, parameters: z.record(z.string(), jsonSchema),
}).strict();
const providerPolicySchema = z.object({
  provider: z.string().min(1), currency: z.string().length(3),
  budgetLimit: z.number().positive(), estimatedCost: z.number().nonnegative(),
  dataHandling: z.string().min(1), approvedOperations: z.array(z.enum(["enroll", "generate"])),
}).strict().refine((policy) => policy.estimatedCost <= policy.budgetLimit, "Estimated cost exceeds budget");
const presenterSampleSchema = z.object({
  asset: artifactRefSchema, mode: z.enum(["fixture", "real"]), consentEvidence: z.string(),
  operationKey: keySchema.optional(),
}).strict();
const lessonOutputSchema = z.object({
  videoId: keySchema, lesson: artifactRefSchema, composition: artifactRefSchema,
  media: artifactRefSchema, captions: z.array(artifactRefSchema),
  presenterMode: z.enum(["fixture", "real"]), presenterSample: artifactRefSchema,
  verifiedPlayable: z.literal(true), operationKey: keySchema.optional(),
}).strict();
const revisionRequestSchema = z.object({
  videoId: keySchema, change: z.enum(["audio", "visual", "script", "captions"]),
  targets: z.array(artifactRefSchema).min(1), reason: z.string().min(1),
  replacements: z.array(artifactRefSchema).default([]),
}).strict();
const revisionPlanSchema = z.object({
  request: artifactRefSchema, affected: z.array(artifactRefSchema),
  reusable: z.array(artifactRefSchema), rebuild: z.array(z.string()),
}).strict();
const skillDraftSchema = z.object({
  name: keySchema, version: versionSchema, documentHash: hashSchema,
  activityKey: keySchema, tests: z.array(relativePathSchema).min(1),
  examples: z.number().int().positive(), reviewNotes: z.string(),
}).strict();
const reportSchema = z.object({
  summary: z.string().min(1), references: z.array(artifactRefSchema).default([]),
  data: z.record(z.string(), jsonSchema).default({}),
}).strict();
const batchPlanSchema = z.object({
  curriculum: artifactRefSchema, style: artifactRefSchema, presenterSample: artifactRefSchema,
  firstLesson: artifactRefSchema, lessons: z.array(artifactRefSchema).min(1),
  providerPolicy: artifactRefSchema, maxConcurrency: z.number().int().min(1).max(4),
}).strict();

export const artifactSchemas = {
  "course-brief": briefSchema,
  evidence: evidenceSchema,
  curriculum: curriculumSchema,
  lesson: lessonSchema,
  scene: sceneSchema,
  "script-storyboard": storyboardSchema,
  asset: assetSchema,
  audio: audioSchema,
  timing: timingSchema,
  captions: captionsSchema,
  composition: compositionSchema,
  "style-spec": styleSpecSchema,
  "style-sample": sampleSchema,
  "style-pack": stylePackSchema,
  "provider-policy": providerPolicySchema,
  "presenter-sample": presenterSampleSchema,
  "lesson-output": lessonOutputSchema,
  "revision-request": revisionRequestSchema,
  "revision-plan": revisionPlanSchema,
  "skill-draft": skillDraftSchema,
  "workflow-report": reportSchema,
  "batch-plan": batchPlanSchema,
} as const;
export type ArtifactKind = keyof typeof artifactSchemas;
export type ArtifactContent<K extends ArtifactKind> = z.output<(typeof artifactSchemas)[K]>;
export const artifactReferenceKinds: Partial<Record<ArtifactKind, Record<string, ArtifactKind>>> = {
  curriculum: { brief: "course-brief", evidence: "evidence" },
  lesson: { curriculum: "curriculum" },
  scene: { assets: "asset" },
  "script-storyboard": { lesson: "lesson", evidence: "evidence" },
  audio: { asset: "asset" },
  timing: { audio: "audio" },
  captions: { audio: "audio", timing: "timing", asset: "asset" },
  composition: { scenes: "scene", audio: "audio", captions: "captions", style: "style-pack" },
  "style-spec": { authorizedReferences: "asset" },
  "style-sample": { asset: "asset" },
  "style-pack": { specification: "style-spec", sample: "style-sample" },
  "presenter-sample": { asset: "asset" },
  "lesson-output": { lesson: "lesson", composition: "composition", media: "asset", captions: "captions", presenterSample: "presenter-sample" },
  "revision-plan": { request: "revision-request" },
  "batch-plan": {
    curriculum: "curriculum", style: "style-pack", presenterSample: "presenter-sample",
    firstLesson: "lesson-output", lessons: "lesson", providerPolicy: "provider-policy",
  },
};
export const artifactKindSchema = z.enum(Object.keys(artifactSchemas) as [ArtifactKind, ...ArtifactKind[]]);
export interface ArtifactRecord<K extends ArtifactKind = ArtifactKind> extends ArtifactRef {
  kind: K;
  content: ArtifactContent<K>;
  dependencies: ArtifactRef[];
  createdAt: number;
  invalidatedAt: number | null;
  invalidationReason: string | null;
}
export type SaveArtifactInput<K extends ArtifactKind = ArtifactKind> = {
  id: string; kind: K; content: z.input<(typeof artifactSchemas)[K]>; dependencies?: ArtifactRef[];
};

export function collectArtifactRefs(value: unknown): ArtifactRef[] {
  const refs = new Map<string, ArtifactRef>();
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    const ref = artifactRefSchema.safeParse(item);
    if (ref.success) {
      refs.set(`${ref.data.id}@${ref.data.version}`, ref.data);
      return;
    }
    for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  return [...refs.values()];
}

export function artifactLineage(kind: ArtifactKind, content: unknown): {
  dependencies: ArtifactRef[]; historical: ArtifactRef[];
} {
  if (kind === "revision-request") {
    const request = revisionRequestSchema.parse(content);
    return { dependencies: request.replacements, historical: request.targets };
  }
  if (kind === "revision-plan") {
    const plan = revisionPlanSchema.parse(content);
    return { dependencies: [plan.request], historical: [...plan.affected, ...plan.reusable] };
  }
  return { dependencies: collectArtifactRefs(content), historical: [] };
}

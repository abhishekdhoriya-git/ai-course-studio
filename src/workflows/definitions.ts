import { workflowDefinitionSchema } from "../domain/runtime.js";
import type { StageDefinition, WorkflowDefinition, WorkflowId } from "../domain/runtime.js";
import type { ApprovalGate } from "../domain/schemas.js";
import { FIXTURE_TEMPLATE_VERSION } from "../media/template.js";

type Requirement = StageDefinition["requirements"][number];
const operationGates: Record<string, ApprovalGate[]> = {
  "presenter:policy": ["provider", "identity-data", "spend"],
  "lesson:presenter": ["presenter-sample"],
  "lesson:approval": ["fixture-review", "first-lesson", "presenter-sample"],
  "lesson:delivery": ["fixture-review", "first-lesson", "presenter-sample"],
  "batch:real-presenter": ["first-lesson", "presenter-sample"],
  "batch:gates": ["curriculum", "style", "presenter-sample", "first-lesson", "lesson", "provider", "identity-data", "spend"],
  "batch:queue": ["curriculum", "style", "presenter-sample", "first-lesson", "lesson", "provider", "identity-data", "spend"],
  "skill:review": ["skill-review"],
  "skill:register": ["skill-review"],
  "skill:invoke": ["skill-review"],
};
function stage(
  id: string, operation: string, requirements: Requirement[], missingInput: string,
  previous?: string, adapter = "studio.local",
): StageDefinition {
  return {
    id, operation, requirements, missingInput,
    dependsOn: previous ? [previous] : [],
    inputSchema: "studio.stage-input@1", outputSchema: "studio.stage-output@1",
    adapter: { id: adapter, version: adapter === "studio.fixture-composition" || adapter === "studio.fixture-render" ? FIXTURE_TEMPLATE_VERSION : "1.0.0" },
    ...(adapter === "studio.skill" ? { skill: "review-artifacts" } : {}),
    approvalGates: [...new Set([
      ...requirements.flatMap((requirement) => requirement.gate ? [requirement.gate] : []),
      ...(operationGates[operation] ?? []),
    ])],
    invalidationDependencies: [...requirements.map((requirement) => requirement.kind), ...(previous ? [previous] : [])],
    retry: { maxAttempts: 3, initialBackoffMs: 100, maxBackoffMs: 1000, multiplier: 2, retryable: ["transient"] },
    timeoutMs: 30000,
  };
}
const inspect = (): StageDefinition => stage(
  "review-inputs", "review-inputs", [], "Load the reviewed artifact-reference skill", undefined, "studio.skill",
);
function definition(id: WorkflowId, description: string, stages: StageDefinition[], version = "1.0.0"): WorkflowDefinition {
  return workflowDefinitionSchema.parse({ id, version, description, stages, maxQueued: 50, maxConcurrency: 2 });
}

export const coursePlanning = definition("course-planning", "Validate supplied evidence and curriculum; never invent teaching material.", [
  inspect(),
  stage("brief", "accept:course-brief", [{ kind: "course-brief" }], "Supply an authored course brief: audience, niche, language, prerequisites and objectives", "review-inputs"),
  stage("evidence", "accept:evidence", [{ kind: "evidence" }], "Supply factual sources, retrieval dates, claim support and explicit trend/platform access gaps", "brief"),
  stage("curriculum-draft", "accept:curriculum", [{ kind: "curriculum" }], "Supply a source-backed, human-authored curriculum draft", "evidence"),
  stage("curriculum-approval", "accept:curriculum", [{ kind: "curriculum", gate: "curriculum" }], "Owner must approve the exact current curriculum version", "curriculum-draft"),
  stage("lesson-queue", "course:lesson-queue", [{ kind: "curriculum", gate: "curriculum" }], "Supply the authored lesson records listed by the approved curriculum", "curriculum-approval"),
]);

export const styleCalibration = definition("style-calibration", "Calibrate authorized observations or an explicitly original style using a real local sample.", [
  inspect(),
  stage("style-specification", "accept:style-spec", [{ kind: "style-spec" }], "Supply observed authorized reference evidence or explicitly original style proposals", "review-inputs"),
  stage("sample-render", "accept:style-sample", [{ kind: "style-sample" }], "Supply a real, locally rendered style sample and asset provenance", "style-specification"),
  stage("style-approval", "accept:style-sample", [{ kind: "style-sample", gate: "style" }], "Owner must approve the exact style sample", "sample-render"),
  stage("versioned-style-pack", "accept:style-pack", [{ kind: "style-pack", gate: "style" }], "Supply and approve a versioned executable style pack linked to that sample", "style-approval"),
]);

export const lessonProduction = definition("lesson-production", "Gate supplied authoring, media and final review; missing production capabilities pause explicitly.", [
  inspect(),
  stage("approved-lesson", "lesson:prerequisites", [
    { kind: "curriculum", gate: "curriculum" }, { kind: "style-pack", gate: "style" }, { kind: "lesson", gate: "lesson" },
  ], "Supply current approved curriculum, style pack and lesson", "review-inputs"),
  stage("research", "accept:evidence", [{ kind: "evidence" }], "Supply claim-supported lesson research; automatic research is not configured", "approved-lesson"),
  stage("script-storyboard", "accept:script-storyboard", [{ kind: "script-storyboard", gate: "script-storyboard" }], "Supply and approve the script/storyboard before any scene work", "research"),
  stage("skill-preflight", "activity:preflight", [{ kind: "script-storyboard", gate: "script-storyboard" }], "Extract, test and review skills for any four-item scene activity", "script-storyboard"),
  stage("scene-assets", "accept:asset", [{ kind: "asset" }], "Supply actual local scene assets with provenance, license and content hashes", "skill-preflight"),
  stage("narration-presenter", "fixture:narration", [{ kind: "script-storyboard", gate: "script-storyboard" }], "Install the local non-cloned fixture narration adapter; production providers remain disabled", "scene-assets", "studio.fixture-narration"),
  stage("alignment", "fixture:alignment", [{ kind: "audio" }], "Align captions using final synthetic-speech audio boundaries", "narration-presenter", "studio.fixture-alignment"),
  stage("composition", "fixture:composition", [{ kind: "captions" }, { kind: "style-pack", gate: "style" }], "Assemble the actual versioned local fixture composition manifest", "alignment", "studio.fixture-composition"),
  {
    ...stage("render-and-checks", "fixture:render", [{ kind: "composition" }], "Render and verify actual local fixture media; real-provider production is disabled", "composition", "studio.fixture-render"),
    timeoutMs: 300000,
  },
  stage("human-review", "lesson:approval", [{ kind: "lesson-output" }], "Owner must approve the current real first lesson or explicitly fixture-only prototype", "render-and-checks"),
  stage("local-delivery", "lesson:delivery", [{ kind: "lesson-output" }], "Deliver only actual reviewed local media and supporting artifacts", "human-review"),
], FIXTURE_TEMPLATE_VERSION);

export const presenterEnrollment = definition("presenter-enrollment", "Identity enrollment is hard-disabled in this local foundation.", [
  inspect(),
  stage("provider-data-spend", "presenter:policy", [{ kind: "provider-policy", gate: "provider" }], "Supply verified provider, data handling and budget policy with separate owner approvals", "review-inputs"),
  stage("recordings-and-verification", "disabled:enrollment", [], "Identity uploads, enrollment and purchases are disabled; no approval can enable this adapter", "provider-data-spend", "studio.disabled"),
  stage("presenter-sample", "accept:presenter-sample", [{ kind: "presenter-sample", gate: "presenter-sample" }], "Supply an actual consented provider sample and approve its exact version", "recordings-and-verification"),
  stage("first-real-lesson", "batch:real-presenter", [{ kind: "lesson-output", gate: "first-lesson" }], "Approve a verified real-presenter lesson, never a fixture", "presenter-sample"),
]);

export const targetedRevision = definition("targeted-revision", "Map exact affected descendants; leave unrelated scenes reusable.", [
  inspect(),
  stage("affected-artifacts", "revision:map", [{ kind: "revision-request" }], "Supply a versioned revision request naming exact affected artifacts", "review-inputs"),
  stage("skill-preflight", "activity:preflight", [{ kind: "revision-request" }], "Review emerging fourth repetitions before revised work begins", "affected-artifacts"),
  stage("regenerate-affected", "revision:replacements", [{ kind: "revision-request" }], "Supply actual revised artifacts; no authoring or media provider is configured", "skill-preflight"),
  stage("rebuild-alignment", "revision:alignment", [{ kind: "revision-request" }], "Audio/script edits require regenerated final-audio timing and captions", "regenerate-affected"),
  stage("renew-review", "lesson:approval", [{ kind: "lesson-output" }], "Renew the exact affected output approvals", "rebuild-alignment"),
  stage("revised-local-export", "lesson:delivery", [{ kind: "lesson-output" }], "Supply the real reviewed revised local export", "renew-review"),
]);

export const skillMaintenance = definition("skill-maintenance", "Reuse first; drafting is never approval or executable authority.", [
  inspect(),
  stage("reuse-search", "skill:reuse", [], "Name the semantic activity needing a reusable capability", "review-inputs"),
  stage("draft-contract", "skill:draft", [], "Supply a skill draft only if no reviewed reusable skill exists", "reuse-search"),
  stage("examples-tests", "skill:examples", [], "Supply representative examples and passing typed adapter contract tests", "draft-contract"),
  stage("independent-review", "skill:review", [], "A new skill needs its own exact-version owner skill-review decision", "examples-tests"),
  stage("register-version", "skill:register", [], "Install a reviewed package and allowlisted adapter; never import generated code", "independent-review"),
  stage("invoke-affected-work", "skill:invoke", [], "Supply validated inputs for the explicitly registered adapter", "register-version"),
]);

export const courseBatch = definition("course-batch", "Queue only approved real-presenter production with known provider/budget and bounded local concurrency.", [
  inspect(),
  stage("current-production-gates", "batch:gates", [
    { kind: "curriculum", gate: "curriculum" }, { kind: "style-pack", gate: "style" },
    { kind: "presenter-sample", gate: "presenter-sample" }, { kind: "lesson-output", gate: "first-lesson" },
    { kind: "batch-plan" }, { kind: "provider-policy", gate: "provider" },
  ], "Current curriculum, style, presenter sample, first REAL-presenter lesson, approved remaining lessons and known budget are mandatory", "review-inputs"),
  stage("skill-preflight", "activity:preflight", [{ kind: "batch-plan" }], "Preflight every foreseeable per-video batch before enqueueing any scene work", "current-production-gates"),
  stage("bounded-queue", "batch:queue", [{ kind: "batch-plan" }], "Queue capacity is bounded; no recursive course batches", "skill-preflight"),
  stage("review-exceptions", "batch:await", [{ kind: "batch-plan" }], "Wait for actual child lesson completion and required owner reviews", "bounded-queue"),
  stage("course-manifest", "batch:manifest", [{ kind: "batch-plan" }], "Package only complete approved local lesson outputs", "review-exceptions"),
]);

export const workflowDefinitions: readonly WorkflowDefinition[] = [
  coursePlanning, styleCalibration, lessonProduction, presenterEnrollment,
  targetedRevision, skillMaintenance, courseBatch,
];
export function getWorkflow(id: string): WorkflowDefinition | undefined {
  const found = workflowDefinitions.find((workflow) => workflow.id === id);
  return found ? structuredClone(found) : undefined;
}

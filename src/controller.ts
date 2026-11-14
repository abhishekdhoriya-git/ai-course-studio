import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { z } from "zod";
import { hashJson, sha256File } from "./domain/hash.js";
import {
  jobInputSchema, stageInputSchema, stageOutputSchema, workflowDefinitionSchema,
} from "./domain/runtime.js";
import type {
  ActivityBatch, JobInputRequest, JobRecord, StageDefinition, StageInput,
  StageOutput, StageOutputRequest, WorkflowDefinition,
} from "./domain/runtime.js";
import { artifactSchemas } from "./domain/schemas.js";
import type {
  ApprovalGate, ArtifactContent, ArtifactKind, ArtifactRecord, ArtifactRef, Json,
} from "./domain/schemas.js";
import {
  LeaseLostError, MissingInputError, PolicyError, StudioError, TransientError,
} from "./domain/errors.js";
import { RepetitionTracker } from "./skills/repetition.js";
import type { SkillRegistry } from "./skills/registry.js";
import type { StudioStore } from "./storage/store.js";
import { workflowDefinitions } from "./workflows/definitions.js";
import { planTargetedRevision } from "./workflows/revision.js";

export interface StageAdapterContext {
  job: JobRecord; stage: StageDefinition; signal: AbortSignal; attempt: number; leaseToken: string;
}
/** Explicit test seams, not paths, shell commands, or generated module names. */
export interface TestStageAdapter {
  id: string; version: string; mode: "test";
  inputSchemaId: "studio.stage-input@1"; outputSchemaId: "studio.stage-output@1";
  execute(input: StageInput, context: StageAdapterContext): Promise<StageOutputRequest> | StageOutputRequest;
}
export interface FixtureStageAdapter {
  id: "studio.fixture-narration" | "studio.fixture-alignment" | "studio.fixture-composition" | "studio.fixture-render";
  version: "1.0.0";
  inputSchemaId: "studio.stage-input@1"; outputSchemaId: "studio.stage-output@1";
  execute(input: StageInput, context: StageAdapterContext, records: ArtifactRecord[]): Promise<StageOutputRequest>;
}
export interface ControllerOptions {
  clock?: () => number;
  leaseMs?: number;
  maxConcurrency?: number;
  maxQueued?: number;
  workspaceRoot?: string;
  workflows?: readonly WorkflowDefinition[];
  testAdapters?: readonly TestStageAdapter[];
  fixtureAdapters?: readonly FixtureStageAdapter[];
}
const fixtureAdapterIds = new Set(["studio.fixture-narration", "studio.fixture-alignment", "studio.fixture-composition", "studio.fixture-render"]);
const reservedAdapters = new Set(["studio.local", "studio.skill", "studio.disabled", ...fixtureAdapterIds]);
const toRef = ({ id, version, hash }: ArtifactRef): ArtifactRef => ({ id, version, hash });

export class StudioController {
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly testAdapters = new Map<string, TestStageAdapter>();
  private readonly fixtureAdapters = new Map<string, FixtureStageAdapter>();
  private readonly clock: () => number;
  private readonly leaseMs: number;
  private readonly maxConcurrency: number;
  private readonly maxQueued: number;
  private readonly workspaceRoot: string;
  private readonly active = new Map<string, AbortController>();
  private stopping = false;
  readonly repetitions: RepetitionTracker;

  constructor(readonly store: StudioStore, readonly registry: SkillRegistry, options: ControllerOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.leaseMs = z.number().int().min(30).max(300000).parse(options.leaseMs ?? 30000);
    this.maxConcurrency = z.number().int().min(1).max(4).parse(options.maxConcurrency ?? 2);
    this.maxQueued = z.number().int().min(1).max(100).parse(options.maxQueued ?? 50);
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    this.repetitions = new RepetitionTracker(store, registry);
    for (const candidate of options.workflows ?? workflowDefinitions) {
      const definition = workflowDefinitionSchema.parse(candidate);
      if (this.definitions.has(definition.id)) throw new StudioError("WORKFLOW_DUPLICATE", "Duplicate workflow ID");
      this.definitions.set(definition.id, definition);
    }
    for (const adapter of options.testAdapters ?? []) {
      const key = `${adapter.id}@${adapter.version}`;
      if (adapter.mode !== "test" || reservedAdapters.has(adapter.id) || this.testAdapters.has(key)) {
        throw new PolicyError("ADAPTER_ALLOWLIST", "Test adapters cannot replace safety-enforcing production adapters");
      }
      this.testAdapters.set(key, adapter);
    }
    for (const adapter of options.fixtureAdapters ?? []) {
      const key = `${adapter.id}@${adapter.version}`;
      if (!fixtureAdapterIds.has(adapter.id) || adapter.version !== "1.0.0" || this.fixtureAdapters.has(key)) {
        throw new PolicyError("ADAPTER_ALLOWLIST", "Only installed, versioned fixture adapters can handle fixture media");
      }
      this.fixtureAdapters.set(key, adapter);
    }
  }

  start(workflowId: string, input: JobInputRequest | ArtifactRef[] = {}): JobRecord {
    return this.startInternal(workflowId, input);
  }
  private startInternal(workflowId: string, input: JobInputRequest | ArtifactRef[], parentJobId?: string, batchKey?: string): JobRecord {
    return this.store.atomic(() => {
      const definition = this.definitions.get(workflowId);
      if (!definition) throw new StudioError("WORKFLOW_NOT_FOUND", `Unknown local workflow: ${workflowId}`);
      const parsed = jobInputSchema.parse(Array.isArray(input) ? { artifacts: input } : input);
      for (const ref of parsed.artifacts) this.store.requireCurrent(ref);
      const pending = this.store.activeJobCount();
      if (pending >= Math.min(this.maxQueued, definition.maxQueued)) throw new MissingInputError("QUEUE_FULL", "The bounded local queue is full");
      const pins = this.registry.list();
      for (const stage of definition.stages) {
        if (stage.skill && !pins.some((pin) => pin.name === stage.skill && !pin.promptOnly)) {
          throw new MissingInputError("SKILL_MISSING", `Load reviewed executable skill: ${stage.skill}`);
        }
      }
      return this.store.createJob({
        definition, input: parsed, skillPins: pins,
        ...(parentJobId ? { parentJobId } : {}), ...(batchKey ? { batchKey } : {}),
      }, this.clock());
    });
  }

  async run(jobId: string): Promise<JobRecord> {
    const initial = this.store.getJob(jobId);
    if (!initial) throw new StudioError("JOB_NOT_FOUND", "Job not found");
    if (this.stopping) return initial;
    if (this.active.size >= this.maxConcurrency) return initial;
    const token = this.store.claimJob(jobId, this.leaseMs, this.clock(), Math.min(this.maxConcurrency, initial.definition.maxConcurrency));
    if (!token) return this.store.getJob(jobId)!;
    const abort = new AbortController();
    this.active.set(jobId, abort);
    const timer = setInterval(() => {
      try { this.store.heartbeat(jobId, token, this.leaseMs, this.clock()); }
      catch (error) { abort.abort(error); }
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    timer.unref();
    let activeStage = initial.definition.stages[0]!;
    try {
      const job = this.store.getJob(jobId)!;
      const definition = workflowDefinitionSchema.parse(job.definition);
      if (hashJson(definition) !== job.definitionHash) throw new StudioError("WORKFLOW_SNAPSHOT", "Persisted workflow definition hash does not match");
      for (const pin of job.skillPins) this.registry.pinned(pin);
      for (const stage of definition.stages) {
        activeStage = stage;
        const current = this.store.getJob(jobId)!;
        const persisted = current.stages.find((item) => item.id === stage.id)!;
        this.store.assertClaim(jobId, token, this.clock());
        abort.signal.throwIfAborted();
        if (persisted.status === "completed") {
          for (const ref of persisted.outputs) this.store.requireCurrent(ref);
          continue;
        }
        try {
          if (persisted.status === "invalidated") throw new StudioError("STALE_INPUT", "Invalidated work requires explicit current inputs", "stale");
          if (stage.dependsOn.some((id) => current.stages.find((item) => item.id === id)?.status !== "completed")) {
            throw new MissingInputError("STAGE_DEPENDENCY", "Required prior stages are not complete");
          }
          const records = this.scope(current, stage);
          this.validateRequirements(stage, records);
          this.assertAdapter(stage, current);
          const input = stageInputSchema.parse({
            jobId, stageId: stage.id, artifacts: records.map(toRef), parameters: current.input.parameters,
            ...(current.input.videoId ? { videoId: current.input.videoId } : {}),
          });
          const attempt = this.store.beginStage(jobId, token, stage.id, this.clock());
          const output = stageOutputSchema.parse(await this.withTimeout(
            this.executeStage(input, { job: current, stage, attempt, signal: abort.signal, leaseToken: token }, records), stage.timeoutMs, abort,
          ));
          abort.signal.throwIfAborted();
          this.store.atomic(() => {
            this.store.assertClaim(jobId, token, this.clock());
            for (const ref of input.artifacts) this.store.requireCurrent(ref);
            const outputs = [...output.references];
            for (const artifact of output.artifacts) {
              outputs.push(this.store.saveArtifact({
                id: `${jobId}:${stage.id}:${artifact.key}`,
                kind: artifact.kind,
                content: artifact.content as ArtifactContent<ArtifactKind>,
                dependencies: artifact.dependencies ?? input.artifacts,
              }, this.clock()));
            }
            this.store.completeStage(jobId, token, stage.id, outputs, this.clock());
          });
        } catch (error) {
          this.handleFailure(jobId, token, stage, error);
          return this.store.getJob(jobId)!;
        }
      }
      const successfulInvocation = this.store.listSkillInvocations(jobId).some((invocation) => invocation.outcome === "succeeded"
        && job.skillPins.some((pin) => pin.packageHash === invocation.pin.packageHash));
      if (!successfulInvocation) throw new PolicyError("SKILL_NOT_INVOKED", "A job cannot complete without a validated pinned skill invocation");
      this.store.finishJob(jobId, token, "completed", null, undefined, this.clock());
    } catch (error) {
      this.handleFailure(jobId, token, activeStage, error);
    } finally {
      clearInterval(timer);
      this.active.delete(jobId);
    }
    return this.store.getJob(jobId)!;
  }

  async runQueued(options: { limit?: number; concurrency?: number } = {}): Promise<JobRecord[]> {
    const limit = z.number().int().min(1).max(this.maxQueued).parse(options.limit ?? this.maxQueued);
    const concurrency = z.number().int().min(1).max(this.maxConcurrency).parse(options.concurrency ?? this.maxConcurrency);
    const ids = this.store.runnableJobIds(limit, this.clock());
    const results: JobRecord[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
      while (next < ids.length) {
        if (this.stopping) break;
        const id = ids[next++]!;
        results.push(await this.run(id));
      }
    }));
    return results;
  }
  cancel(jobId: string): void {
    this.store.cancelJob(jobId, this.clock());
    this.active.get(jobId)?.abort(new StudioError("CANCELLED", "Job cancelled", "cancelled"));
  }
  resume(jobId: string, additions?: ArtifactRef[]): JobRecord {
    if (additions?.length) this.store.addJobInputs(jobId, additions, this.clock());
    return this.store.resumeJob(jobId, this.clock());
  }
  recover(): string[] { return this.store.recoverExpired(this.clock()); }
  shutdown(): void {
    this.stopping = true;
    for (const jobId of this.active.keys()) this.cancel(jobId);
  }

  private handleFailure(jobId: string, token: string, stage: StageDefinition, error: unknown): void {
    try { this.store.assertClaim(jobId, token, this.clock()); } catch { return; }
    if (error instanceof LeaseLostError) return;
    const failure = error instanceof StudioError ? error
      : new StudioError(error instanceof z.ZodError ? "VALIDATION_FAILED" : "ADAPTER_FAILED",
        error instanceof Error ? error.message : "Local stage failed");
    const persisted = this.store.getJob(jobId)!.stages.find((item) => item.id === stage.id)!;
    const retry = error instanceof TransientError && persisted.attempts < stage.retry.maxAttempts;
    const pause = failure.classification === "missing-input" || failure.classification === "stale";
    const backoff = Math.min(stage.retry.maxBackoffMs,
      stage.retry.initialBackoffMs * stage.retry.multiplier ** Math.max(0, persisted.attempts - 1));
    this.store.stopStage({
      jobId, token, stageId: stage.id, status: retry ? "retry-wait" : pause ? "paused" : "failed",
      code: retry || !(error instanceof TransientError) ? failure.code : "ATTEMPTS_EXHAUSTED",
      message: retry || !(error instanceof TransientError) ? failure.message : `Attempts exhausted: ${failure.message}`,
      classification: failure.classification,
      ...(retry ? { nextAttemptAt: this.clock() + backoff } : {}),
    }, this.clock());
  }
  private scope(job: JobRecord, stage: StageDefinition): ArtifactRecord[] {
    const refs = [...job.input.artifacts, ...stage.dependsOn.flatMap((id) => job.stages.find((item) => item.id === id)!.outputs)];
    const found = new Map<string, ArtifactRecord>();
    for (let index = 0; index < refs.length; index++) {
      const ref = refs[index]!;
      const key = `${ref.id}@${ref.version}`;
      if (found.has(key)) continue;
      const record = this.store.requireCurrent(ref);
      found.set(key, record);
      refs.push(...record.dependencies);
    }
    return [...found.values()];
  }
  private validateRequirements(stage: StageDefinition, records: ArtifactRecord[]): void {
    for (const requirement of stage.requirements) {
      const matches = records.filter((record) => record.kind === requirement.kind);
      if (matches.length === 0) throw new MissingInputError("MISSING_ARTIFACT", `${stage.missingInput} [${requirement.kind}]`);
      for (const record of matches) {
        if (requirement.gate) this.requireApproval(record, requirement.gate);
        this.validateResources(record);
      }
    }
  }
  private requireApproval(ref: ArtifactRef, gate: ApprovalGate): void {
    if (!this.store.isApproved(ref, gate)) throw new MissingInputError("APPROVAL_REQUIRED", `Approve current ${ref.id}@${ref.version} at gate ${gate}`);
  }
  private validateResources(record: ArtifactRecord, visited = new Set<string>()): void {
    const key = `${record.id}@${record.version}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (record.kind === "asset") {
      const asset = artifactSchemas.asset.parse(record.content);
      const path = resolve(this.workspaceRoot, ...asset.path.split(/[\\/]/));
      let actual: string;
      try { actual = realpathSync(path); }
      catch { throw new MissingInputError("RESOURCE_MISSING", `Required local asset is unavailable: ${asset.path}`); }
      const location = relative(realpathSync(this.workspaceRoot), actual);
      if (location === ".." || location.startsWith(`..${sep}`) || /^[a-zA-Z]:/.test(location)) {
        throw new PolicyError("ASSET_PATH", "Assets cannot escape the configured local workspace");
      }
      let hash: string;
      try { hash = sha256File(actual); }
      catch { throw new MissingInputError("RESOURCE_MISSING", `Required local asset cannot be read: ${asset.path}`); }
      if (hash !== asset.sha256) throw new StudioError("RESOURCE_HASH", `Local asset changed: ${asset.path}`);
    }
    for (const dependency of record.dependencies) this.validateResources(this.store.requireCurrent(dependency), visited);
  }
  private assertAdapter(stage: StageDefinition, job: JobRecord): void {
    if (fixtureAdapterIds.has(stage.adapter.id)) {
      if (job.input.parameters["fixture"] !== true) {
        throw new MissingInputError("PRODUCTION_MEDIA_DISABLED", "Only the labeled engineering fixture renderer is installed. A real pilot needs owner decisions and approved providers.");
      }
      if (!this.fixtureAdapters.has(`${stage.adapter.id}@${stage.adapter.version}`)) {
        throw new MissingInputError("FIXTURE_RENDERER_MISSING", `Install the exact local fixture adapter: ${stage.adapter.id}@${stage.adapter.version}`);
      }
      return;
    }
    if (reservedAdapters.has(stage.adapter.id)) {
      if (stage.adapter.version !== "1.0.0") throw new MissingInputError("PINNED_ADAPTER_MISSING", "The exact pinned local adapter version is unavailable");
      if (stage.adapter.id === "studio.skill") {
        const pin = job.skillPins.find((candidate) => candidate.name === stage.skill);
        if (!pin) throw new MissingInputError("SKILL_MISSING", "The job has no pin for its required skill");
        this.registry.pinned(pin);
      }
      return;
    }
    const adapter = this.testAdapters.get(`${stage.adapter.id}@${stage.adapter.version}`);
    if (!adapter || adapter.inputSchemaId !== stage.inputSchema || adapter.outputSchemaId !== stage.outputSchema) {
      throw new MissingInputError("PINNED_ADAPTER_MISSING", `Exact allowlisted adapter unavailable: ${stage.adapter.id}@${stage.adapter.version}`);
    }
  }
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, abort: AbortController): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new StudioError("ADAPTER_TIMEOUT", "Local adapter exceeded its deadline; it will not be blindly retried");
          reject(error);
          abort.abort(error);
        }, timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async executeStage(input: StageInput, context: StageAdapterContext, records: ArtifactRecord[]): Promise<StageOutput> {
    const { stage, job } = context;
    if (stage.adapter.id === "studio.disabled" || stage.operation.startsWith("disabled:")) {
      throw new PolicyError("EXTERNAL_EFFECTS_DISABLED", "Enrollment, identity uploads, provider spend, payments and publication are hard-disabled");
    }
    if (stage.adapter.id === "studio.skill") {
      const pin = job.skillPins.find((candidate) => candidate.name === stage.skill)!;
      const result = await this.registry.invoke(pin, {
        subject: job.workflowId,
        artifacts: records.map((record) => ({ ref: toRef(record), kind: record.kind, current: this.store.isCurrent(record) })),
      }, {
        jobId: job.id, stageId: stage.id, invocationKey: stage.id, attempt: context.attempt, signal: context.signal,
      });
      return this.report("Validated supplied artifact references; human and content review remain required", input.artifacts, { review: result });
    }
    if (fixtureAdapterIds.has(stage.adapter.id)) {
      return stageOutputSchema.parse(await this.fixtureAdapters.get(`${stage.adapter.id}@${stage.adapter.version}`)!.execute(input, context, records));
    }
    if (stage.adapter.id !== "studio.local") {
      return stageOutputSchema.parse(await this.testAdapters.get(`${stage.adapter.id}@${stage.adapter.version}`)!.execute(input, context));
    }
    const first = <K extends ArtifactKind>(kind: K): ArtifactRecord<K> => {
      const record = records.find((item) => item.kind === kind);
      if (!record) throw new MissingInputError("MISSING_ARTIFACT", `${stage.missingInput} [${kind}]`);
      return record as ArtifactRecord<K>;
    };
    if (stage.operation.startsWith("accept:")) {
      const kind = stage.operation.slice(7);
      return this.report(`Accepted supplied ${kind}; no authoring or media generation was performed`,
        records.filter((record) => record.kind === kind).map(toRef));
    }
    switch (stage.operation) {
      case "course:lesson-queue": {
        const curriculum = artifactSchemas.curriculum.parse(first("curriculum").content);
        const lessons = records.filter((record) => record.kind === "lesson");
        if (curriculum.lessons.some((lesson) => !lessons.some((record) => record.id === lesson.id))) {
          throw new MissingInputError("LESSONS_MISSING", "Supply authored lesson records matching every approved curriculum lesson ID");
        }
        return this.report("Authored lesson queue is ready for separate lesson approvals", lessons.map(toRef));
      }
      case "lesson:prerequisites": {
        const lesson = artifactSchemas.lesson.parse(first("lesson").content);
        this.requireApproval(lesson.curriculum, "curriculum");
        if (job.input.videoId && lesson.videoId !== job.input.videoId) throw new StudioError("VIDEO_MISMATCH", "Lesson belongs to a different video");
        return this.report("Current lesson prerequisites are approved", input.artifacts);
      }
      case "activity:preflight": {
        const batches: ActivityBatch[] = [...job.input.activities];
        for (const record of records.filter((item) => item.kind === "script-storyboard")) {
          const storyboard = artifactSchemas["script-storyboard"].parse(record.content);
          for (const scene of storyboard.scenes) {
            for (const activityKey of scene.activities) batches.push({
              videoId: scene.videoId, activityKey, workItemIds: [scene.sceneId],
            });
          }
        }
        this.repetitions.preflight(batches, job.skillPins);
        return this.report("All foreseeable per-video activity unions passed preflight", input.artifacts, { batches: batches.length });
      }
      case "presenter:policy": {
        const policy = first("provider-policy");
        this.requireApproval(policy, "identity-data"); this.requireApproval(policy, "spend");
        return this.report("Policy decisions recorded; external enrollment remains disabled", [toRef(policy)]);
      }
      case "lesson:presenter": {
        const sample = first("presenter-sample");
        const content = artifactSchemas["presenter-sample"].parse(sample.content);
        if (content.mode === "real") this.requireRealPresenter(sample);
        return this.report(`Validated supplied ${content.mode} presenter and measured audio references`, input.artifacts);
      }
      case "lesson:alignment":
      case "revision:alignment": {
        if (stage.operation === "revision:alignment") {
          const revision = artifactSchemas["revision-request"].parse(first("revision-request").content);
          if (revision.change !== "audio" && revision.change !== "script") return this.report("Audio alignment remains reusable for this edit", input.artifacts);
        }
        const timing = first("timing");
        const captions = first("captions");
        this.validateResources(timing); this.validateResources(captions);
        return this.report("Accepted supplied final-audio timing and captions", [toRef(timing), toRef(captions)]);
      }
      case "lesson:render": {
        const output = first("lesson-output");
        this.validateResources(output);
        return this.report("Accepted supplied playable-media evidence; no renderer was invoked by the controller", [toRef(output)]);
      }
      case "lesson:approval":
      case "lesson:delivery": {
        const output = first("lesson-output");
        const content = artifactSchemas["lesson-output"].parse(output.content);
        this.requireApproval(output, content.presenterMode === "fixture" ? "fixture-review" : "first-lesson");
        if (content.presenterMode === "real") this.requireRealPresenter(this.store.getArtifact(content.presenterSample));
        this.validateResources(output);
        return this.report(stage.operation === "lesson:delivery" ? "Reviewed supplied output is ready for local delivery only" : "Exact output version has the required owner review", [toRef(output)]);
      }
      case "revision:map": {
        const request = first("revision-request");
        const revision = artifactSchemas["revision-request"].parse(request.content);
        const impact = planTargetedRevision(this.store, revision);
        return {
          summary: "Mapped affected descendants; unrelated scenes remain reusable", references: [],
          artifacts: [{
            key: "impact", kind: "revision-plan",
            content: { request: toRef(request), ...impact }, dependencies: [toRef(request)],
          }],
        };
      }
      case "revision:replacements": {
        const request = artifactSchemas["revision-request"].parse(first("revision-request").content);
        const candidates = [...request.replacements.map((ref) => this.store.requireCurrent(ref)), ...records];
        const replacements = request.targets.map((target) => {
          const replacement = candidates.find((candidate) => candidate.id === target.id && candidate.version > target.version);
          if (!replacement) throw new MissingInputError("REVISED_MEDIA_REQUIRED", `Supply an actual newer version of ${target.id}; historical revision intent does not regenerate media`);
          this.validateResources(replacement);
          return toRef(replacement);
        });
        return this.report("Accepted explicit newer replacement versions; unrelated scenes were not regenerated", replacements);
      }
      case "skill:reuse":
      case "skill:draft":
      case "skill:examples":
      case "skill:review":
      case "skill:register":
      case "skill:invoke":
        return this.maintainSkill(input, context, records);
      case "batch:real-presenter": {
        const output = first("lesson-output");
        this.requireRealLesson(output);
        return this.report("Verified real-presenter first lesson", [toRef(output)]);
      }
      case "batch:gates": {
        this.validateBatch(first("batch-plan"));
        return this.report("Current real-presenter course gates passed", input.artifacts);
      }
      case "batch:queue": {
        const plan = first("batch-plan");
        this.validateBatch(plan);
        const content = artifactSchemas["batch-plan"].parse(plan.content);
        const children = this.store.atomic(() => {
          const existing = this.store.listJobs({ parentJobId: job.id });
          const needed = content.lessons.filter((lesson) => !existing.some((child) => child.input.artifacts.some((ref) => ref.id === lesson.id && ref.version === lesson.version)));
          if (needed.length + this.store.activeJobCount() > this.maxQueued) throw new MissingInputError("QUEUE_FULL", "Batch exceeds the bounded local queue capacity");
          return content.lessons.map((lesson) => existing.find((child) => child.input.artifacts.some((ref) => ref.id === lesson.id && ref.version === lesson.version))
            ?? this.startInternal("lesson-production", {
              artifacts: [lesson, content.curriculum, content.style, content.presenterSample],
              videoId: artifactSchemas.lesson.parse(this.store.getArtifact(lesson).content).videoId,
            }, job.id, `${lesson.id}@${lesson.version}`));
        });
        return this.report("Bounded child lessons queued, not completed", input.artifacts, { childJobIds: children.map((child) => child.id), concurrency: Math.min(content.maxConcurrency, this.maxConcurrency) });
      }
      case "batch:await":
      case "batch:manifest": {
        const children = this.store.listJobs({ parentJobId: job.id });
        if (!children.length || children.some((child) => child.status !== "completed")) throw new MissingInputError("BATCH_CHILDREN_PENDING", "Child lessons need actual production, evidence and approvals; resume after completion");
        return this.report("All bounded child lessons completed locally", input.artifacts, { childJobIds: children.map((child) => child.id) });
      }
      default: throw new PolicyError("OPERATION_NOT_ALLOWED", `Local operation is not allowlisted: ${stage.operation}`);
    }
  }

  private requireRealPresenter(record: ArtifactRecord): void {
    const sample = artifactSchemas["presenter-sample"].parse(record.content);
    if (sample.mode !== "real" || !sample.consentEvidence || !sample.operationKey) {
      throw new PolicyError("REAL_PRESENTER_REQUIRED", "Fixture or unverified presenter samples cannot unlock real production");
    }
    this.requireApproval(record, "presenter-sample");
    const operation = this.store.getProviderOperation(sample.operationKey);
    const asset = this.store.getArtifact<"asset">(sample.asset);
    if (operation?.mode !== "production" || operation.state !== "completed" || !operation.remoteJobId || artifactSchemas.asset.parse(asset.content).fixture) {
      throw new PolicyError("REAL_PROVIDER_EVIDENCE_REQUIRED", "Real production needs a reconciled production-provider operation; test adapters and fixture assets never qualify");
    }
  }
  private requireRealLesson(record: ArtifactRecord): void {
    const output = artifactSchemas["lesson-output"].parse(record.content);
    if (output.presenterMode !== "real") throw new PolicyError("FIXTURE_BATCH_FORBIDDEN", "A fixture first lesson never unlocks course batch");
    this.requireApproval(record, "first-lesson");
    this.requireRealPresenter(this.store.getArtifact(output.presenterSample));
    const media = artifactSchemas.asset.parse(this.store.getArtifact(output.media).content);
    if (media.fixture) throw new PolicyError("FIXTURE_BATCH_FORBIDDEN", "Fixture media never unlocks course batch");
    this.validateResources(record);
  }
  private validateBatch(record: ArtifactRecord): void {
    const plan = artifactSchemas["batch-plan"].parse(record.content);
    this.requireApproval(plan.curriculum, "curriculum"); this.requireApproval(plan.style, "style");
    this.requireRealPresenter(this.store.getArtifact(plan.presenterSample));
    this.requireRealLesson(this.store.getArtifact(plan.firstLesson));
    for (const lesson of plan.lessons) {
      this.requireApproval(lesson, "lesson");
      artifactSchemas.lesson.parse(this.store.getArtifact(lesson).content);
    }
    const policy = this.store.getArtifact(plan.providerPolicy);
    artifactSchemas["provider-policy"].parse(policy.content);
    this.requireApproval(policy, "provider"); this.requireApproval(policy, "identity-data"); this.requireApproval(policy, "spend");
    // No production adapters are installed in the foundation, regardless of forged gate records.
    throw new MissingInputError("PRODUCTION_PROVIDER_DISABLED", "Provider capability, entitlements and actual budget accounting are not configured; batch dispatch is disabled");
  }
  private async maintainSkill(input: StageInput, context: StageAdapterContext, records: ArtifactRecord[]): Promise<StageOutput> {
    if (input.parameters["activityKey"] === undefined) {
      throw new MissingInputError("ACTIVITY_KEY_REQUIRED", "Name the semantic activity needing a reusable skill; no activity was supplied");
    }
    const activityKey = z.string().min(1).parse(input.parameters["activityKey"]);
    const reused = context.job.skillPins.find((pin) => this.registry.forActivity(activityKey, pin));
    if (reused) {
      if (context.stage.operation === "skill:invoke") {
        const invocationInput = input.parameters["skillInput"];
        if (invocationInput === undefined) throw new MissingInputError("SKILL_INPUT_REQUIRED", "Supply actual typed inputs for the affected skill invocation");
        const result = await this.registry.invoke(reused, invocationInput, {
          jobId: context.job.id, stageId: context.stage.id, invocationKey: activityKey,
          attempt: context.attempt, signal: context.signal,
        });
        return this.report("Invoked existing reviewed pinned skill on supplied work", input.artifacts, { result });
      }
      return this.report("Reusing an existing reviewed tested skill; no duplicate draft or self-approval", input.artifacts, { skill: reused.name, version: reused.version });
    }
    if (context.stage.operation === "skill:reuse") return this.report("No reviewed reusable skill exists for the named activity", input.artifacts);
    const draft = records.find((record) => record.kind === "skill-draft");
    if (!draft) throw new MissingInputError("SKILL_DRAFT_REQUIRED", "No reusable skill exists. Supply a draft, representative examples, typed tests and independent review");
    const content = artifactSchemas["skill-draft"].parse(draft.content);
    if (context.stage.operation === "skill:examples") {
      const candidates = await this.registry.load({ dryRun: true });
      if (!candidates.some((pin) => pin.name === content.name && pin.version === content.version && pin.documentHash === content.documentHash)) {
        throw new MissingInputError("SKILL_EXAMPLES_REQUIRED", "Install a candidate package with passing representative adapter examples; dry-run testing grants no admission or approval");
      }
      return this.report("Candidate typed adapter examples passed; independent review is still required", [toRef(draft)]);
    }
    if (context.stage.operation === "skill:review" || context.stage.operation === "skill:register" || context.stage.operation === "skill:invoke") {
      this.requireApproval(draft, "skill-review");
    }
    if (context.stage.operation === "skill:register" || context.stage.operation === "skill:invoke") {
      // Loading is explicit maintenance, never a production job silently upgrading its pins.
      await this.registry.load();
      const pin = this.registry.pin(content.name);
      if (pin.version !== content.version || pin.documentHash !== content.documentHash || !this.registry.forActivity(activityKey, pin)) {
        throw new StudioError("SKILL_DRAFT_PIN", "Reviewed draft does not match the installed tested package");
      }
      context.signal.throwIfAborted();
      this.store.addReviewedJobSkill(context.job.id, context.leaseToken, pin, toRef(draft), this.clock());
      return this.report("Exact independently reviewed package registered and explicitly pinned for affected work", [toRef(draft)], { skill: pin.name, version: pin.version });
    }
    return this.report("Draft recorded; no approval was granted and no generated code executed", [toRef(draft)]);
  }
  private report(summary: string, references: ArtifactRef[], data: Record<string, Json> = {}): StageOutput {
    return {
      summary, references,
      artifacts: [{
        key: "report", kind: "workflow-report",
        content: { summary, references: references.map(toRef), data }, dependencies: [],
      }],
    };
  }
}

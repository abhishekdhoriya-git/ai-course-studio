import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { z } from "zod";
import { StudioStore } from "./storage/store.js";
import { SkillRegistry } from "./skills/registry.js";
import { StudioController } from "./controller.js";
import type { FixtureStageAdapter } from "./controller.js";
import { artifactSchemas, artifactRefSchema, approvalGateSchema, artifactKindSchema, jsonSchema } from "./domain/schemas.js";
import type { ArtifactContent, ArtifactKind, ArtifactRef } from "./domain/schemas.js";
import { StudioError, StaleInputError } from "./domain/errors.js";
import { currentFixture, fixtureGates, prepareFixture, refreshFixtureScene, requireFixtureGates } from "./fixture.js";
import { FIXTURE_VIDEO_ID } from "./media/contracts.js";
import { qualityRounds } from "./quality/progress.js";
import { workflowDefinitions } from "./workflows/definitions.js";
import type { ReviewDecision, ReviewState } from "./review-contract.js";

const toRef = ({ id, version, hash }: ArtifactRef): ArtifactRef => ({ id, version, hash });
export interface AppOptions {
  workspaceRoot?: string;
  dataDirectory?: string;
  fixtureAdapters?: (store: StudioStore, workspaceRoot: string, registry: SkillRegistry) => readonly FixtureStageAdapter[];
}
export class StudioApp {
  readonly root: string;
  readonly store: StudioStore;
  readonly registry: SkillRegistry;
  readonly controller: StudioController;
  readonly token = randomUUID();
  private readonly pending = new Set<Promise<void>>();
  private readonly hasRenderer: boolean;
  private readonly verificationMode: boolean;
  private closing = false;

  private constructor(options: AppOptions) {
    this.root = resolve(options.workspaceRoot ?? process.cwd());
    const data = options.dataDirectory ?? ".studio";
    if (/^(?:[a-zA-Z]:|[\\/])/.test(data) || data.split(/[\\/]/).includes("..") || data.split(/[\\/]/)[0] !== ".studio") {
      throw new StudioError("DATA_DIRECTORY", "Use a relative directory inside .studio for private local data.");
    }
    this.store = new StudioStore(join(this.root, ...data.split(/[\\/]/), "studio.sqlite"));
    this.verificationMode = data.split(/[\\/]/)[1] === "verification";
    this.registry = new SkillRegistry(this.store, { root: join(this.root, ".github", "skills") });
    const fixtureAdapters = options.fixtureAdapters?.(this.store, this.root, this.registry) ?? [];
    this.hasRenderer = fixtureAdapters.length === 4;
    this.controller = new StudioController(this.store, this.registry, { workspaceRoot: this.root, fixtureAdapters });
  }

  static async open(options: AppOptions = {}): Promise<StudioApp> {
    const app = new StudioApp(options);
    try {
      await app.registry.load();
      app.controller.recover();
      return app;
    } catch (error) {
      app.store.close();
      throw error;
    }
  }

  state(): ReviewState {
    const all = this.store.listArtifacts({ currentOnly: false });
    const jobs = this.store.listJobs({ limit: 1000 });
    const fixture = currentFixture(this.store);
    const decisions = this.store.listDecisions().map((row): ReviewDecision => {
      const decision = z.object({
        artifact_id: z.string(), version: z.number(), gate: approvalGateSchema,
        decision: z.enum(["approved", "rejected"]), note: z.string().nullable(),
        invalidated_at: z.number().nullable(),
      }).passthrough().parse(row);
      return {
        artifactId: decision.artifact_id, version: decision.version, gate: decision.gate,
        decision: decision.decision, note: decision.note, invalidatedAt: decision.invalidated_at,
      };
    });
    const gates = fixture ? fixtureGates(this.store, fixture) : [];
    const output = this.store.latestArtifact("fixture:output");
    return {
      token: this.token,
      verificationMode: this.verificationMode,
      artifacts: all.slice(-500),
      jobs: jobs.slice(-50).map(({ leaseToken: _lease, ...job }) => job),
      decisions: decisions.slice(-500),
      workflows: workflowDefinitions.map((workflow) => ({
        id: workflow.id, version: workflow.version, description: workflow.description, stageCount: workflow.stages.length,
      })),
      skills: this.registry.list(), repetitions: this.store.listActivitySummaries(), quality: qualityRounds(this.store),
      fixture: fixture ? {
        title: fixture.title, manifest: toRef(this.store.latestArtifact("fixture:manifest")!),
        poster: fixture.poster, output: output && this.store.isCurrent(output) ? output : null,
        gates, readyToRender: this.hasRenderer && gates.every((gate) => gate.approved),
      } : null,
      totals: { artifacts: all.length, jobs: jobs.length, invocations: this.store.listSkillInvocations().length },
    };
  }

  async loadFixture(): Promise<ArtifactRef> {
    const plan = prepareFixture(this.store, this.root);
    const existing = this.store.listJobs({ limit: 1000 }).find((job) =>
      job.workflowId === "course-planning" && job.input.videoId === FIXTURE_VIDEO_ID);
    if (!existing) {
      const inputs = this.store.listArtifacts().filter((artifact) => artifact.id.startsWith("fixture:"));
      const job = this.controller.start("course-planning", { artifacts: inputs.map(toRef), videoId: plan.videoId });
      await this.controller.run(job.id);
    }
    return this.store.latestArtifact("fixture:manifest")!;
  }

  saveArtifact(raw: unknown): ArtifactRef {
    const input = z.object({
      id: z.string().min(1), kind: artifactKindSchema, content: jsonSchema,
      expectedVersion: z.number().int().nonnegative(),
      dependencies: z.array(artifactRefSchema).optional(),
    }).strict().parse(raw);
    return this.store.atomic(() => {
      const previous = this.store.latestArtifact(input.id);
      if ((previous?.version ?? 0) !== input.expectedVersion) throw new StaleInputError("This artifact changed. Reload its current version before saving.");
      const content = artifactSchemas[input.kind].parse(input.content) as ArtifactContent<ArtifactKind>;
      const updated = this.store.saveArtifact({
        id: input.id, kind: input.kind, content,
        dependencies: input.dependencies ?? previous?.dependencies ?? [],
      });
      refreshFixtureScene(this.store, updated);
      return updated;
    });
  }

  decide(raw: unknown): void {
    const input = z.object({
      artifactId: z.string().min(1), version: z.number().int().positive(),
      gate: approvalGateSchema, decision: z.enum(["approved", "rejected"]),
      note: z.string().max(4000).optional(),
    }).strict().parse(raw);
    const { note, ...decision } = input;
    this.store.recordDecision({ ...decision, ...(note === undefined ? {} : { note }) });
  }

  revise(raw: unknown): string {
    const input = z.object({
      target: artifactRefSchema, change: z.enum(["audio", "visual", "script", "captions"]),
      reason: z.string().trim().min(1).max(4000),
    }).strict().parse(raw);
    const target = this.store.requireCurrent(input.target);
    const videoId = currentFixture(this.store)?.videoId ?? (
      "videoId" in target.content && typeof target.content.videoId === "string" ? target.content.videoId : "local-revision"
    );
    const id = `revision:${randomUUID()}`;
    const request = this.store.saveArtifact({
      id, kind: "revision-request", content: { videoId, change: input.change, targets: [input.target], reason: input.reason },
    });
    const job = this.controller.start("targeted-revision", {
      artifacts: [request], videoId,
      activities: [{ videoId, activityKey: "revise-scene", workItemIds: [id] }],
    });
    this.schedule(job.id);
    return job.id;
  }

  renderFixture(): string {
    const plan = currentFixture(this.store);
    if (!plan) throw new StudioError("FIXTURE_MISSING", "Load or renew the engineering fixture first.");
    requireFixtureGates(this.store, plan);
    if (!this.hasRenderer) throw new StudioError("FIXTURE_RENDERER_MISSING", "The local renderer is not installed in this runtime.");
    return this.store.atomic(() => {
      const existing = this.store.listJobs({ limit: 1000 }).find((job) => job.workflowId === "lesson-production"
        && job.input.videoId === plan.videoId && ["queued", "running", "retry-wait"].includes(job.status));
      if (existing) return existing.id;
      const inputs = this.store.listArtifacts().filter((artifact) => artifact.id.startsWith("fixture:")
        && !["audio", "timing", "captions", "composition", "lesson-output"].includes(artifact.kind)
        && !artifact.id.startsWith("fixture:media") && !artifact.id.startsWith("fixture:speech:"));
      const job = this.controller.start("lesson-production", {
        artifacts: inputs.map(toRef), videoId: plan.videoId, parameters: { fixture: true },
      });
      this.schedule(job.id);
      return job.id;
    });
  }

  schedule(jobId: string): void {
    if (this.closing) throw new StudioError("SHUTDOWN", "The local studio is shutting down.");
    const work = this.controller.run(jobId).then((result) => {
      if (result.status === "failed") console.error(`Job ${result.id}: ${result.reason}`);
    }).catch((error: unknown) => {
      console.error("Local worker failed:", error instanceof Error ? error.message : "Unknown worker error");
    }).finally(() => this.pending.delete(work));
    this.pending.add(work);
  }

  async tick(): Promise<void> {
    if (this.closing) return;
    const work = this.controller.runQueued({ limit: 10, concurrency: 2 }).then(() => undefined)
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
    await work;
  }
  async drain(): Promise<void> { await Promise.all(this.pending); }

  async close(): Promise<void> {
    this.closing = true;
    this.controller.shutdown();
    await Promise.all(this.pending);
    this.store.close();
  }
}

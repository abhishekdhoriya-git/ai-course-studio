import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { StudioController } from "../src/controller.js";
import type { ControllerOptions, TestStageAdapter } from "../src/controller.js";
import { StudioStore } from "../src/storage/store.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { coursePlanning, workflowDefinitions } from "../src/workflows/definitions.js";
import { StudioError, TransientError } from "../src/domain/errors.js";
import { sha256 } from "../src/domain/hash.js";
import type { ArtifactRef, ApprovalGate } from "../src/domain/schemas.js";
import type { WorkflowDefinition } from "../src/domain/runtime.js";
import { reviewArtifactsAdapter } from "../src/skills/adapters.js";

async function fixture(t: TestContext) {
  const directory = join(process.cwd(), ".studio", "foundation-tests", randomUUID());
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "studio.sqlite");
  let store = new StudioStore(path);
  const peers: StudioStore[] = [];
  let registry = new SkillRegistry(store);
  await registry.load();
  let now = 10000;
  t.after(() => { for (const peer of peers) peer.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    directory, path, get store() { return store; }, get registry() { return registry; },
    get now() { return now; }, advance(ms: number) { now += ms; },
    controller(options: ControllerOptions = {}) { return new StudioController(store, registry, { clock: () => now, ...options }); },
    peerStore() { const peer = new StudioStore(path); peers.push(peer); return peer; },
    async reopen() { store.close(); store = new StudioStore(path); registry = new SkillRegistry(store); await registry.load(); },
  };
}
function testWorkflow(adapterId = "test.work", adapterVersion = "1.0.0"): WorkflowDefinition {
  return {
    ...structuredClone(coursePlanning), id: "test-local", description: "Deterministic local test, not media production",
    stages: [
      structuredClone(coursePlanning.stages[0]!),
      {
        ...structuredClone(coursePlanning.stages[1]!), id: "work", operation: "test",
        dependsOn: ["review-inputs"], requirements: [], approvalGates: [], invalidationDependencies: ["review-inputs"],
        adapter: { id: adapterId, version: adapterVersion },
        retry: { maxAttempts: 3, initialBackoffMs: 10, maxBackoffMs: 100, multiplier: 2, retryable: ["transient"] },
      },
    ],
  };
}
function adapter(execute: TestStageAdapter["execute"], version = "1.0.0"): TestStageAdapter {
  return { id: "test.work", version, mode: "test", inputSchemaId: "studio.stage-input@1", outputSchemaId: "studio.stage-output@1", execute };
}
const done = () => ({
  summary: "Completed deterministic test work",
  artifacts: [{ key: "result", kind: "workflow-report" as const, content: { summary: "Actual local test adapter ran" } }],
});
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

test("seven real workflow definitions pause on specific missing author/evidence inputs, after invoking a validated skill", async (t) => {
  const f = await fixture(t);
  assert.equal(workflowDefinitions.length, 7);
  for (const definition of workflowDefinitions) {
    const controller = f.controller();
    const job = controller.start(definition.id);
    const result = await controller.run(job.id);
    assert.equal(result.status, "paused", `${definition.id}: ${result.reason}`);
    assert.equal(f.store.listSkillInvocations(job.id).filter((invocation) => invocation.outcome === "succeeded").length, 1);
    assert.notEqual(result.reason, null);
    assert.equal(f.store.listArtifacts({ kind: "lesson-output" }).length, 0);
  }
});

test("explicit missing-input additions and approvals resume without rerunning completed checks", async (t) => {
  const f = await fixture(t);
  const controller = f.controller();
  const job = controller.start("course-planning");
  assert.match((await controller.run(job.id)).reason!, /authored course brief/);
  const brief = f.store.saveArtifact({
    id: "brief", kind: "course-brief",
    content: { title: "Test-only course", niche: "Local testing", audience: "Developers", language: "en", prerequisites: [], objectives: ["Observe explicit pause states"] },
  });
  controller.resume(job.id, [brief]);
  const result = await controller.run(job.id);
  assert.equal(result.status, "paused");
  assert.match(result.reason!, /factual sources/);
  assert.equal(result.stages[0]?.attempts, 1);
  assert.equal(f.store.listSkillInvocations(job.id).length, 1);
  assert.equal(f.store.listArtifacts({ kind: "curriculum" }).length, 0);
});

test("only explicit transient faults retry, with durable next-attempt times and no early execution", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const controller = f.controller({ workflows: [testWorkflow()], testAdapters: [adapter(() => {
    if (++calls === 1) throw new TransientError("NETWORK_TEST", "Temporary test fault");
    return done();
  })] });
  const job = controller.start("test-local");
  const waiting = await controller.run(job.id);
  assert.equal(waiting.status, "retry-wait");
  assert.equal(waiting.nextAttemptAt, f.now + 10);
  await controller.run(job.id);
  assert.equal(calls, 1);
  f.advance(10);
  const finished = await controller.run(job.id);
  assert.equal(finished.status, "completed");
  assert.equal(calls, 2);
  assert.equal(finished.stages[1]?.attempts, 2);
  assert.equal(f.store.listSkillInvocations(job.id).length, 1);
});

test("attempt exhaustion is finite and survives database reopen", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const options = { workflows: [testWorkflow()], testAdapters: [adapter(() => { calls++; throw new TransientError("BUSY", "Test service busy"); })] };
  let controller = f.controller(options);
  const job = controller.start("test-local");
  assert.equal((await controller.run(job.id)).status, "retry-wait");
  await f.reopen(); controller = f.controller(options);
  f.advance(10);
  assert.equal((await controller.run(job.id)).status, "retry-wait");
  f.advance(20);
  const exhausted = await controller.run(job.id);
  assert.equal(exhausted.status, "failed");
  assert.match(exhausted.reason!, /ATTEMPTS_EXHAUSTED/);
  f.advance(10000); await controller.run(job.id);
  assert.equal(calls, 3);
  assert.equal(f.store.listAttempts(job.id).filter((attempt) => attempt["stage_id"] === "work").length, 3);
});

test("permanent validation and unknown retryable-looking errors do not retry", async (t) => {
  const f = await fixture(t);
  for (const error of [new StudioError("INVALID_MANIFEST", "Permanent test validation"), Object.assign(new Error("not explicitly transient"), { retryable: true })]) {
    let calls = 0;
    const controller = f.controller({ workflows: [testWorkflow()], testAdapters: [adapter(() => { calls++; throw error; })] });
    const job = controller.start("test-local");
    assert.equal((await controller.run(job.id)).status, "failed");
    controller.cancel(job.id); controller.resume(job.id);
    f.advance(10000); await controller.run(job.id);
    assert.equal(calls, 1);
  }
});

test("lease/token claims prevent duplicate concurrent processing from two controller instances", async (t) => {
  const f = await fixture(t);
  const started = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  const options = { workflows: [testWorkflow()], testAdapters: [adapter(async () => { calls++; started.resolve(); await release.promise; return done(); })] };
  const first = f.controller(options);
  const peer = f.peerStore();
  const peerRegistry = new SkillRegistry(peer);
  await peerRegistry.load();
  const second = new StudioController(peer, peerRegistry, { ...options, clock: () => f.now });
  const job = first.start("test-local");
  const running = first.run(job.id);
  await started.promise;
  assert.equal((await second.run(job.id)).status, "running");
  assert.equal(calls, 1);
  release.resolve();
  assert.equal((await running).status, "completed");
});

test("expired running work recovers from disk without rerunning an approved completed stage", async (t) => {
  const f = await fixture(t);
  let workCalls = 0;
  const options = { workflows: [testWorkflow()], testAdapters: [adapter(() => { workCalls++; return done(); })] };
  let controller = f.controller(options);
  const job = controller.start("test-local");
  const token = f.store.claimJob(job.id, 100, f.now)!;
  const attempt = f.store.beginStage(job.id, token, "review-inputs", f.now);
  await f.registry.invoke(f.registry.pin("review-artifacts"), { subject: "interrupted test", artifacts: [] }, {
    jobId: job.id, stageId: "review-inputs", invocationKey: "review-inputs", attempt,
  });
  const approvedOutput = f.store.saveArtifact({ id: "approved-completed-check", kind: "workflow-report", content: { summary: "Completed before interruption" } });
  f.store.completeStage(job.id, token, "review-inputs", [approvedOutput], f.now);
  f.store.recordDecision({ artifactId: approvedOutput.id, version: approvedOutput.version, gate: "lesson", decision: "approved" });
  f.store.beginStage(job.id, token, "work", f.now);
  await f.reopen(); f.advance(101); controller = f.controller(options);
  assert.deepEqual(controller.recover(), [job.id]);
  const result = await controller.run(job.id);
  assert.equal(result.status, "completed");
  assert.equal(workCalls, 1);
  assert.equal(result.stages[0]?.attempts, 1);
  assert.equal(f.store.listSkillInvocations(job.id).length, 1);
  assert.equal(f.store.isApproved(approvedOutput, "lesson"), true);
  assert(f.store.listAttempts(job.id).some((entry) => entry["outcome"] === "interrupted"));
});

test("job definitions and exact adapter versions are snapshots, not the current workflow registry", async (t) => {
  const f = await fixture(t);
  const old = testWorkflow();
  const before = f.controller({ workflows: [old], testAdapters: [adapter(done)] });
  const job = before.start("test-local");
  const upgraded = { ...testWorkflow("test.work", "2.0.0"), version: "2.0.0" };
  const after = f.controller({ workflows: [upgraded], testAdapters: [adapter(done)] });
  assert.equal((await after.run(job.id)).status, "completed");
  assert.equal(f.store.getJob(job.id)?.workflowVersion, "1.0.0");
  const future = after.start("test-local");
  const paused = await after.run(future.id);
  assert.equal(paused.status, "paused");
  assert.match(paused.reason!, /Exact allowlisted adapter unavailable/);
});

test("stale job inputs are rejected at start and revoke an in-flight worker's ability to commit", async (t) => {
  const f = await fixture(t);
  const started = deferred<void>(); const release = deferred<void>();
  const controller = f.controller({
    workflows: [testWorkflow()], testAdapters: [adapter(async () => { started.resolve(); await release.promise; return done(); })],
  });
  const input = f.store.saveArtifact({ id: "changing-input", kind: "workflow-report", content: { summary: "original" } });
  const job = controller.start("test-local", [input]);
  const running = controller.run(job.id);
  await started.promise;
  f.store.saveArtifact({ id: input.id, kind: "workflow-report", content: { summary: "replacement" } });
  assert.throws(() => controller.start("test-local", [input]), /no longer current/);
  release.resolve();
  const result = await running;
  assert.equal(result.status, "paused");
  assert.match(result.reason!, /STALE_INPUT/);
  assert.equal(f.store.latestArtifact(`${job.id}:work:result`), undefined);
  assert.throws(() => controller.resume(job.id), /no longer current/);
});

test("cancelled work cannot commit, and resume preserves completed unaffected stages", async (t) => {
  const f = await fixture(t);
  const started = deferred<void>(); const release = deferred<void>();
  let calls = 0;
  const controller = f.controller({
    workflows: [testWorkflow()], testAdapters: [adapter(async () => {
      calls++;
      if (calls === 1) { started.resolve(); await release.promise; }
      return done();
    })],
  });
  const job = controller.start("test-local");
  const running = controller.run(job.id);
  await started.promise;
  controller.cancel(job.id); release.resolve();
  assert.equal((await running).status, "cancelled");
  assert.equal(f.store.latestArtifact(`${job.id}:work:result`), undefined);
  controller.resume(job.id);
  assert.equal((await controller.run(job.id)).status, "completed");
  assert.equal(calls, 2);
  assert.equal(f.store.listSkillInvocations(job.id).length, 1);
});

test("local queue capacity and concurrency remain bounded", async (t) => {
  const f = await fixture(t);
  let active = 0; let high = 0;
  const controller = f.controller({
    workflows: [testWorkflow()], maxQueued: 2, maxConcurrency: 2,
    testAdapters: [adapter(async () => {
      active++; high = Math.max(high, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--; return done();
    })],
  });
  controller.start("test-local"); controller.start("test-local");
  assert.throws(() => controller.start("test-local"), /queue is full/);
  const results = await controller.runQueued({ concurrency: 2 });
  assert.equal(results.length, 2);
  assert(results.every((job) => job.status === "completed"));
  assert(high <= 2);
});

test("forged provider/data/spend approvals cannot enable enrollment or publishing adapters", async (t) => {
  const f = await fixture(t);
  const policy = f.store.saveArtifact({
    id: "policy", kind: "provider-policy",
    content: { provider: "unconfigured", currency: "USD", budgetLimit: 1, estimatedCost: 0, dataHandling: "Test-only no transfer", approvedOperations: ["enroll"] },
  });
  for (const gate of ["provider", "identity-data", "spend"] satisfies ApprovalGate[]) {
    f.store.recordDecision({ artifactId: policy.id, version: policy.version, gate, decision: "approved" });
  }
  const controller = f.controller();
  const job = controller.start("presenter-enrollment", [policy]);
  const result = await controller.run(job.id);
  assert.equal(result.status, "failed");
  assert.match(result.reason!, /EXTERNAL_EFFECTS_DISABLED/);
  assert.equal(f.store.getProviderOperation("enrollment"), undefined);
  assert.throws(() => f.controller({ testAdapters: [{ ...adapter(done), id: "studio.disabled" }] }), /cannot replace/);
});

test("a forged first-lesson approval on fixture media never unlocks course batch", async (t) => {
  const f = await fixture(t);
  const brief = f.store.saveArtifact({
    id: "brief", kind: "course-brief", content: { title: "Fixture", niche: "Tests", audience: "Tests", language: "en", prerequisites: [], objectives: ["Test gates"] },
  });
  const evidence = f.store.saveArtifact({
    id: "evidence", kind: "evidence",
    content: { sources: [{ url: "https://example.test", retrievedAt: "2026-01-01T00:00:00.000Z", title: "Synthetic fixture", supports: ["Test only"], uncertainty: "Not real research", rights: "Test fixture" }], accessGaps: ["All real platforms"], claims: [] },
  });
  const curriculum = f.store.saveArtifact({
    id: "curriculum", kind: "curriculum", content: { title: "Fixture", brief, evidence, lessons: [{ id: "remaining", title: "Fixture", objective: "Test", prerequisites: [] }] },
  });
  const lesson = f.store.saveArtifact({ id: "remaining", kind: "lesson", content: { courseId: "fixture", videoId: "v", title: "Fixture", objective: "Test", curriculum } });
  const path = join(f.directory, "not-a-real-render.txt"); writeFileSync(path, "explicit fixture only");
  const asset = f.store.saveArtifact({
    id: "fixture-media", kind: "asset",
    content: { path: relative(process.cwd(), path), sha256: sha256("explicit fixture only"), mediaType: "text/plain", provenance: "Synthetic test data", rights: "Test-only", fixture: true },
  });
  const specification = f.store.saveArtifact({ id: "spec", kind: "style-spec", content: { origin: "original", observations: [], proposals: ["Fixture"], authorizedReferences: [], parameters: {} } });
  const sample = f.store.saveArtifact({ id: "style-sample", kind: "style-sample", content: { asset, fixture: true, notes: "Fixture only" } });
  const style = f.store.saveArtifact({ id: "style", kind: "style-pack", content: { specification, sample, templateVersion: "1.0.0", parameters: {} } });
  const scene = f.store.saveArtifact({ id: "scene", kind: "scene", content: { videoId: "v", sceneId: "s", purpose: "Test", script: "Fixture", visual: "Fixture", assets: [asset] } });
  const audio = f.store.saveArtifact({ id: "audio", kind: "audio", content: { sceneId: "s", asset, durationMs: 1, measured: true, transcript: "Fixture", fixture: true } });
  const composition = f.store.saveArtifact({ id: "composition", kind: "composition", content: { videoId: "v", scenes: [scene], audio: [audio], captions: [], style } });
  const presenter = f.store.saveArtifact({ id: "presenter", kind: "presenter-sample", content: { asset, mode: "fixture", consentEvidence: "" } });
  const output = f.store.saveArtifact({ id: "first-lesson", kind: "lesson-output", content: { videoId: "v", lesson, composition, media: asset, captions: [], presenterMode: "fixture", presenterSample: presenter, verifiedPlayable: true } });
  const policy = f.store.saveArtifact({ id: "policy", kind: "provider-policy", content: { provider: "unknown", currency: "USD", budgetLimit: 1, estimatedCost: 0, dataHandling: "None", approvedOperations: ["generate"] } });
  const plan = f.store.saveArtifact({ id: "batch", kind: "batch-plan", content: { curriculum, style, presenterSample: presenter, firstLesson: output, lessons: [lesson], providerPolicy: policy, maxConcurrency: 2 } });
  for (const [ref, gate] of [[curriculum, "curriculum"], [style, "style"], [presenter, "presenter-sample"], [output, "first-lesson"], [lesson, "lesson"], [policy, "provider"], [policy, "identity-data"], [policy, "spend"]] as [ArtifactRef, ApprovalGate][]) {
    f.store.recordDecision({ artifactId: ref.id, version: ref.version, gate, decision: "approved" });
  }
  const controller = f.controller();
  const job = controller.start("course-batch", [plan]);
  const result = await controller.run(job.id);
  assert.notEqual(result.status, "completed");
  assert.match(result.reason!, /Fixture|fixture/);
  assert.equal(f.store.listJobs({ parentJobId: job.id }).length, 0);
});

test("controller preflight blocks the foreseeable fourth before any affected adapter executes", async (t) => {
  const f = await fixture(t);
  let workCalls = 0;
  const definition = testWorkflow();
  const work = definition.stages[1]!;
  definition.stages = [
    definition.stages[0]!,
    { ...structuredClone(work), id: "preflight", adapter: { id: "studio.local", version: "1.0.0" }, operation: "activity:preflight" },
    { ...work, dependsOn: ["preflight"] },
  ];
  const controller = f.controller({ workflows: [definition], testAdapters: [adapter(() => { workCalls++; return done(); })] });
  const job = controller.start("test-local", { activities: [{ videoId: "v", activityKey: "source-broll", workItemIds: ["a", "b", "c", "d"] }] });
  const paused = await controller.run(job.id);
  assert.equal(paused.status, "paused");
  assert.match(paused.reason!, /SKILL_EXTRACTION_REQUIRED/);
  assert.equal(workCalls, 0);
  assert.equal(controller.repetitions.count("v", "source-broll"), 0);
  assert.equal(paused.stages[2]?.attempts, 0);
});

test("missing resources pause explicitly and changed resource hashes fail without executing or retrying", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const definition = testWorkflow();
  definition.stages[1]!.requirements = [{ kind: "asset" }];
  const path = join(f.directory, "missing.txt");
  const asset = f.store.saveArtifact({
    id: "missing-resource", kind: "asset",
    content: { path: relative(process.cwd(), path), sha256: sha256("expected"), mediaType: "text/plain", provenance: "Test", rights: "Test-only", fixture: true },
  });
  const controller = f.controller({ workflows: [definition], testAdapters: [adapter(() => { calls++; return done(); })] });
  const job = controller.start("test-local", [asset]);
  const paused = await controller.run(job.id);
  assert.equal(paused.status, "paused");
  assert.match(paused.reason!, /RESOURCE_MISSING/);
  assert.equal(paused.stages[1]?.attempts, 0);
  writeFileSync(path, "unexpected bytes");
  controller.resume(job.id);
  const failed = await controller.run(job.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.reason!, /RESOURCE_HASH/);
  assert.equal(calls, 0);
});

test("skill maintenance tests a candidate but cannot approve it; separate review enables exact pinned invocation", async (t) => {
  const f = await fixture(t);
  const root = join(f.directory, "skills");
  cpSync(join(process.cwd(), ".github", "skills"), root, { recursive: true });
  const local = { ...reviewArtifactsAdapter, id: "test.review-fixture", activityKeys: ["review-fixture"] };
  const registry = new SkillRegistry(f.store, { root, adapters: [local] });
  await registry.load();
  const folder = join(root, "review-fixture");
  cpSync(join(root, "review-artifacts"), folder, { recursive: true });
  const document = join(folder, "SKILL.md");
  writeFileSync(document, readFileSync(document, "utf8").replace("name: review-artifacts", "name: review-fixture").replaceAll("studio.review-artifacts", local.id));
  const metadata = join(folder, "artefact.yaml");
  writeFileSync(metadata, readFileSync(metadata, "utf8").replace("name: review-artifacts", "name: review-fixture")
    .replace("activityKeys: [review-artifacts, review-scene]", "activityKeys: [review-fixture]").replace("id: studio.review-artifacts", `id: ${local.id}`));
  const draft = f.store.saveArtifact({
    id: "draft", kind: "skill-draft",
    content: { name: "review-fixture", version: "1.0.0", documentHash: sha256(readFileSync(document)), activityKey: "review-fixture", tests: ["tests\\controller.test.ts"], examples: 2, reviewNotes: "Await independent test owner decision" },
  });
  const controller = new StudioController(f.store, registry, { clock: () => f.now });
  const job = controller.start("skill-maintenance", {
    artifacts: [draft], parameters: { activityKey: "review-fixture", skillInput: { subject: "test work", artifacts: [] } },
  });
  const paused = await controller.run(job.id);
  assert.equal(paused.status, "paused");
  assert.match(paused.reason!, /skill-review/);
  assert.equal(f.store.isApproved(draft, "skill-review"), false);
  assert.equal(f.store.getSkillSnapshot("review-fixture", "1.0.0"), undefined);
  f.store.recordDecision({ artifactId: draft.id, version: draft.version, gate: "skill-review", decision: "approved" });
  controller.resume(job.id);
  const completed = await controller.run(job.id);
  assert.equal(completed.status, "completed");
  assert(completed.skillPins.some((pin) => pin.name === "review-fixture" && pin.documentHash === sha256(readFileSync(document))));
  assert.equal(f.store.listSkillInvocations(job.id).filter((invocation) => invocation.outcome === "succeeded").length, 2);
});

test("adapter outputs can declare exact scene lineage so a sibling remains approved after revision", async (t) => {
  const f = await fixture(t);
  const a = f.store.saveArtifact({ id: "scene-a-source", kind: "workflow-report", content: { summary: "Scene A input" } });
  const b = f.store.saveArtifact({ id: "scene-b-source", kind: "workflow-report", content: { summary: "Scene B input" } });
  const controller = f.controller({
    workflows: [testWorkflow()],
    testAdapters: [adapter(() => ({
      summary: "Produced independent deterministic scene outputs",
      artifacts: [
        { key: "a", kind: "workflow-report", content: { summary: "Derived scene A" }, dependencies: [a] },
        { key: "b", kind: "workflow-report", content: { summary: "Derived scene B" }, dependencies: [b] },
      ],
    }))],
  });
  const job = controller.start("test-local", [a, b]);
  assert.equal((await controller.run(job.id)).status, "completed");
  const outputA = f.store.latestArtifact(`${job.id}:work:a`)!;
  const outputB = f.store.latestArtifact(`${job.id}:work:b`)!;
  for (const ref of [outputA, outputB]) f.store.recordDecision({ artifactId: ref.id, version: ref.version, gate: "lesson", decision: "approved" });
  f.store.saveArtifact({ id: a.id, kind: "workflow-report", content: { summary: "Revised scene A input" } });
  assert.equal(f.store.isCurrent(outputA), false);
  assert.equal(f.store.isApproved(outputB, "lesson"), true);
});

test("targeted revision preserves historical intent while accepting newer affected versions without restarting completed mapping", async (t) => {
  const f = await fixture(t);
  const original = f.store.saveArtifact({ id: "visual-a", kind: "workflow-report", content: { summary: "Original scene A visual" } });
  const sibling = f.store.saveArtifact({ id: "visual-b", kind: "workflow-report", content: { summary: "Unrelated scene B visual" } });
  f.store.recordDecision({ artifactId: sibling.id, version: sibling.version, gate: "lesson", decision: "approved" });
  const request = f.store.saveArtifact({
    id: "revision-request", kind: "revision-request",
    content: { videoId: "v", change: "visual", targets: [original], reason: "Replace only scene A visual" },
  });
  const controller = f.controller();
  const job = controller.start("targeted-revision", [request]);
  const waiting = await controller.run(job.id);
  assert.equal(waiting.status, "paused");
  assert.match(waiting.reason!, /actual newer version/);
  const mapped = waiting.stages.find((stage) => stage.id === "affected-artifacts")!;
  assert.equal(mapped.status, "completed");
  const replacement = f.store.saveArtifact({ id: original.id, kind: "workflow-report", content: { summary: "Actual replacement scene A visual" } });
  assert.equal(f.store.isCurrent(request), true);
  for (const ref of mapped.outputs) assert.equal(f.store.isCurrent(ref), true);
  controller.resume(job.id, [replacement]);
  const resumed = await controller.run(job.id);
  assert.equal(resumed.stages.find((stage) => stage.id === "regenerate-affected")?.status, "completed");
  assert.equal(resumed.stages.find((stage) => stage.id === "affected-artifacts")?.attempts, 1);
  assert.equal(resumed.status, "paused");
  assert.match(resumed.reason!, /lesson-output/);
  assert.equal(f.store.isApproved(sibling, "lesson"), true);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { StudioStore } from "../src/storage/store.js";
import type { ArtifactRef } from "../src/domain/schemas.js";
import { StaleInputError } from "../src/domain/errors.js";
import { planTargetedRevision } from "../src/workflows/revision.js";
import { coursePlanning } from "../src/workflows/definitions.js";
import { jobInputSchema } from "../src/domain/runtime.js";

function fixture(t: TestContext): { store: StudioStore; reopen(): StudioStore } {
  const directory = join(process.cwd(), ".studio", "foundation-tests", randomUUID());
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "studio.sqlite");
  let store = new StudioStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    get store() { return store; },
    reopen() { store.close(); store = new StudioStore(path); return store; },
  };
}
function report(store: StudioStore, id: string, summary: string, dependencies: ArtifactRef[] = []): ArtifactRef {
  return store.saveArtifact({ id, kind: "workflow-report", content: { summary }, dependencies });
}
function approve(store: StudioStore, ref: ArtifactRef): void {
  store.recordDecision({ artifactId: ref.id, version: ref.version, gate: "lesson", decision: "approved" });
}

test("artifact replacement invalidates own and transitive decisions atomically, retaining siblings after reopen", (t) => {
  const f = fixture(t);
  const root = report(f.store, "scene-a", "first");
  const timing = report(f.store, "timing-a", "timing", [root]);
  const captions = report(f.store, "captions-a", "captions", [timing]);
  const sibling = report(f.store, "scene-b", "unaffected");
  for (const ref of [root, timing, captions, sibling]) approve(f.store, ref);
  const replacement = report(f.store, "scene-a", "second");
  assert.equal(replacement.version, 2);
  assert.equal(f.store.isApproved(root, "lesson"), false);
  assert.equal(f.store.isApproved(timing, "lesson"), false);
  assert.equal(f.store.isApproved(captions, "lesson"), false);
  assert.equal(f.store.isApproved(sibling, "lesson"), true);
  assert.equal(f.store.getArtifact<"workflow-report">(root).content.summary, "first");
  const store = f.reopen();
  assert.equal(store.isApproved(sibling, "lesson"), true);
  assert.notEqual(store.getArtifact(captions).invalidatedAt, null);
  assert.equal(store.latestArtifact(root.id)?.version, 2);
});

test("stale approvals, hash substitutions and dependencies are rejected without creating versions", (t) => {
  const { store } = fixture(t);
  const old = report(store, "draft", "one");
  report(store, "draft", "two");
  assert.throws(() => approve(store, old), StaleInputError);
  assert.throws(() => report(store, "derived", "bad", [old]), StaleInputError);
  assert.equal(store.latestArtifact("derived"), undefined);
  assert.throws(() => store.getArtifact({ ...old, hash: "0".repeat(64) }), StaleInputError);
});

test("canonical content reuses a current immutable version, but invalidated outputs must get a new version", (t) => {
  const { store } = fixture(t);
  const first = report(store, "stable", "same");
  assert.deepEqual(report(store, "stable", "same"), first);
  store.invalidateArtifacts([first], "Revision requested");
  assert.equal(report(store, "stable", "same").version, 2);
});

test("embedded typed lineage invalidates audio timing, captions and composition, not another scene", (t) => {
  const { store } = fixture(t);
  const asset = store.saveArtifact({
    id: "audio-file", kind: "asset",
    content: { path: "media\\audio.wav", sha256: "1".repeat(64), mediaType: "audio/wav", provenance: "test fixture", rights: "test only", fixture: true },
  });
  const audio = store.saveArtifact({
    id: "audio-a", kind: "audio",
    content: { sceneId: "a", asset, durationMs: 1000, measured: true, transcript: "Original", fixture: true },
  });
  const timing = store.saveArtifact({
    id: "timing-a", kind: "timing", content: { sceneId: "a", audio, segments: [{ startMs: 0, endMs: 1000, text: "Original" }] },
  });
  const captions = store.saveArtifact({ id: "captions-a", kind: "captions", content: { sceneId: "a", audio, timing, asset } });
  const composition = report(store, "composition", "scene a composition", [captions]);
  const sibling = report(store, "audio-b", "other scene");
  approve(store, sibling);
  const impact = planTargetedRevision(store, { targets: [audio], change: "audio" });
  assert.deepEqual(new Set(impact.affected.map((ref) => ref.id)), new Set(["audio-a", "timing-a", "captions-a", "composition"]));
  assert(impact.reusable.some((ref) => ref.id === sibling.id));
  store.saveArtifact({
    id: "audio-a", kind: "audio",
    content: { sceneId: "a", asset, durationMs: 1100, measured: true, transcript: "Revised", fixture: true },
  });
  assert.equal(store.isCurrent(timing), false);
  assert.equal(store.isCurrent(captions), false);
  assert.equal(store.isCurrent(composition), false);
  assert.equal(store.isApproved(sibling, "lesson"), true);
});

test("a failed transaction cannot partly replace artifacts or invalidate approvals", (t) => {
  const { store } = fixture(t);
  const original = report(store, "atomic", "one");
  const dependent = report(store, "dependent", "unchanged", [original]);
  approve(store, original); approve(store, dependent);
  assert.throws(() => store.atomic(() => {
    report(store, "atomic", "two");
    throw new Error("simulate crash before commit");
  }));
  assert.deepEqual(store.latestArtifact("atomic")?.version, 1);
  assert.equal(store.isApproved(original, "lesson"), true);
  assert.equal(store.isApproved(dependent, "lesson"), true);
});

test("revoking a current approval invalidates descendants without deleting the input", (t) => {
  const { store } = fixture(t);
  const input = report(store, "approved-input", "input");
  const downstream = report(store, "derived-output", "derived", [input]);
  approve(store, input); approve(store, downstream);
  store.recordDecision({ artifactId: input.id, version: input.version, gate: "lesson", decision: "rejected" });
  assert.equal(store.isCurrent(input), true);
  assert.equal(store.isCurrent(downstream), false);
  assert.equal(store.isApproved(input, "lesson"), false);
});

test("revocation fences root-consuming in-flight work before any descendant output exists, preserving unrelated leases", (t) => {
  const f = fixture(t);
  const input = report(f.store, "revoked-root", "current content");
  const sibling = report(f.store, "unrelated-root", "unaffected");
  approve(f.store, input); approve(f.store, sibling);
  const makeJob = (ref: ArtifactRef) => f.store.createJob({
    definition: coursePlanning, input: jobInputSchema.parse({ artifacts: [ref] }), skillPins: [],
  }, 1000);
  const job = makeJob(input);
  const other = makeJob(sibling);
  const token = f.store.claimJob(job.id, 10000, 1000)!;
  const otherToken = f.store.claimJob(other.id, 10000, 1000)!;
  f.store.beginStage(job.id, token, "review-inputs", 1000);
  f.store.recordDecision({ artifactId: input.id, version: input.version, gate: "lesson", decision: "rejected" }, 1001);
  assert.equal(f.store.isCurrent(input), true);
  assert.equal(f.store.getJob(job.id)?.status, "paused");
  assert.equal(f.store.getJob(job.id)?.stages[0]?.status, "invalidated");
  assert.throws(() => f.store.assertClaim(job.id, token, 1002));
  assert.throws(() => f.store.completeStage(job.id, token, "review-inputs", [input], 1002));
  f.store.assertClaim(other.id, otherToken, 1002);
  const reopened = f.reopen();
  assert.equal(reopened.isApproved(input, "lesson"), false);
  assert.equal(reopened.isApproved(sibling, "lesson"), true);
  assert.equal(reopened.getJob(job.id)?.leaseToken, null);
  assert(reopened.listAttempts(job.id).some((attempt) => attempt["outcome"] === "invalidated"));
});

test("revocation also fences a root held only as a prior stage reference, without invalidating its content", (t) => {
  const { store } = fixture(t);
  const root = report(store, "stage-held-root", "current");
  approve(store, root);
  const job = store.createJob({ definition: coursePlanning, input: jobInputSchema.parse({}), skillPins: [] }, 1000);
  const token = store.claimJob(job.id, 10000, 1000)!;
  store.beginStage(job.id, token, "review-inputs", 1000);
  store.completeStage(job.id, token, "review-inputs", [root], 1000);
  store.beginStage(job.id, token, "brief", 1000);
  store.recordDecision({ artifactId: root.id, version: root.version, gate: "lesson", decision: "rejected" }, 1001);
  assert.equal(store.isCurrent(root), true);
  assert.equal(store.getJob(job.id)?.status, "paused");
  assert.equal(store.getJob(job.id)?.stages[0]?.status, "invalidated");
  assert.throws(() => store.assertClaim(job.id, token, 1002));
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { StudioStore } from "../src/storage/store.js";
import { SkillRegistry, GAUNTLET_COMMIT } from "../src/skills/registry.js";
import { RepetitionTracker } from "../src/skills/repetition.js";
import { SkillExtractionRequired } from "../src/domain/errors.js";
import type { ActivityEventKind } from "../src/storage/store.js";
import { sha256 } from "../src/domain/hash.js";
import { reviewArtifactsAdapter } from "../src/skills/adapters.js";
import type { LocalSkillAdapter } from "../src/skills/adapters.js";

async function fixture(t: TestContext, copy = false, adapters: LocalSkillAdapter[] = []) {
  const directory = join(process.cwd(), ".studio", "foundation-tests", randomUUID());
  mkdirSync(directory, { recursive: true });
  const dbPath = join(directory, "studio.sqlite");
  let store = new StudioStore(dbPath);
  const root = copy ? join(directory, "skills") : join(process.cwd(), ".github", "skills");
  if (copy) cpSync(join(process.cwd(), ".github", "skills"), root, { recursive: true });
  let registry = new SkillRegistry(store, { root, adapters });
  await registry.load();
  let tracker = new RepetitionTracker(store, registry);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    root,
    get store() { return store; }, get registry() { return registry; }, get tracker() { return tracker; },
    async reopen() {
      store.close(); store = new StudioStore(dbPath); registry = new SkillRegistry(store, { root, adapters });
      await registry.load(); tracker = new RepetitionTracker(store, registry);
    },
  };
}

test("three distinct per-video work items are allowed; the emerging fourth is blocked before it starts", async (t) => {
  const f = await fixture(t);
  for (const id of ["one", "two", "three"]) f.tracker.record({
    eventId: id, videoId: "video-a", activityKey: "source-broll", workItemId: id, kind: "work-item",
  });
  assert.equal(f.tracker.count("video-a", "source-broll"), 3);
  assert.throws(() => f.tracker.record({
    eventId: "four", videoId: "video-a", activityKey: "source-broll", workItemId: "four", kind: "work-item",
  }), SkillExtractionRequired);
  assert.equal(f.store.activityItems("video-a", "source-broll").filter((item) => item.started).length, 3);
});

test("foreseeable union at four blocks the whole batch before any reservation or work", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.tracker.preflight([
    { videoId: "v", activityKey: "source-broll", workItemIds: ["a", "b"] },
    { videoId: "v", activityKey: "source-broll", workItemIds: ["c", "d"] },
  ]), SkillExtractionRequired);
  assert.equal(f.tracker.count("v", "source-broll"), 0);
  f.tracker.preflight([{ videoId: "v", activityKey: "source-broll", workItemIds: ["a", "b", "c"] }]);
  assert.throws(() => f.tracker.preflight([{ videoId: "v", activityKey: "source-broll", workItemIds: ["c", "d"] }]), SkillExtractionRequired);
  assert.equal(f.tracker.count("v", "source-broll"), 3);
  assert.equal(f.store.activityItems("v", "source-broll").some((item) => item.started), false);
});

test("videos never aggregate, and a registered reviewed tested skill is reusable at four", async (t) => {
  const f = await fixture(t);
  for (const videoId of ["a", "b"]) f.tracker.preflight([{ videoId, activityKey: "source-broll", workItemIds: ["1", "2", "3"] }]);
  assert.equal(f.tracker.count("a", "source-broll"), 3);
  assert.equal(f.tracker.count("b", "source-broll"), 3);
  for (const videoId of ["same-id-a", "same-id-b"]) f.tracker.record({
    eventId: "stable-scene-event", videoId, activityKey: "source-broll", workItemId: "scene-1", kind: "work-item",
  });
  assert.equal(f.tracker.count("same-id-a", "source-broll"), 1);
  assert.equal(f.tracker.count("same-id-b", "source-broll"), 1);
  f.tracker.preflight([{ videoId: "c", activityKey: "review-scene", workItemIds: ["1", "2", "3", "4", "5"] }]);
  assert.equal(f.tracker.count("c", "review-scene"), 5);
  assert.equal(f.registry.forActivity("source-broll"), undefined);
});

test("retry/poll/frame/controller/resume events and resumed stable work IDs do not inflate counts across reopen", async (t) => {
  const f = await fixture(t);
  for (const workItemId of ["a", "b", "c"]) f.tracker.record({
    eventId: workItemId, videoId: "v", activityKey: "source-broll", workItemId, kind: "work-item",
  });
  await f.reopen();
  for (const kind of ["retry", "poll", "frame", "controller", "resume"] satisfies ActivityEventKind[]) {
    for (let i = 0; i < 6; i++) f.tracker.record({
      eventId: `${kind}-${i}`, videoId: "v", activityKey: "source-broll", workItemId: `noise-${i}`, kind,
    });
  }
  f.tracker.record({ eventId: "resumed-attempt-a", videoId: "v", activityKey: "source-broll", workItemId: "a", kind: "work-item" });
  f.tracker.record({ eventId: "resumed-attempt-a", videoId: "v", activityKey: "source-broll", workItemId: "a", kind: "work-item" });
  assert.equal(f.tracker.count("v", "source-broll"), 3);
  assert.throws(() => f.tracker.record({ eventId: "four", videoId: "v", activityKey: "source-broll", workItemId: "d", kind: "work-item" }), SkillExtractionRequired);
});

test("same-version document mutation is rejected, but an archived old pin still invokes its exact adapter", async (t) => {
  const f = await fixture(t, true);
  const pin = f.registry.pin("review-artifacts");
  const document = join(f.root, "review-artifacts", "SKILL.md");
  writeFileSync(document, `${readFileSync(document, "utf8")}\nA mutation without a version bump.\n`);
  await assert.rejects(f.registry.load(), /changed without a version bump/);
  await assert.rejects(f.reopen(), /changed without a version bump/);
  const output = await f.registry.invoke(pin, { subject: "old pinned job", artifacts: [] }, {
    jobId: "old-job", stageId: "review", invocationKey: "scene-1", attempt: 1,
  });
  assert.deepEqual(output, { checked: 0, issues: [{ code: "NO_INPUTS", artifactId: null }], humanReviewRequired: true });
  const metadata = join(f.root, "review-artifacts", "artefact.yaml");
  writeFileSync(metadata, readFileSync(metadata, "utf8").replace("version: 1.0.0", "version: 1.1.0"));
  await assert.rejects(f.registry.load(), /independent current skill-review decision/);
  const draft = f.store.saveArtifact({
    id: "review-artifacts-1.1.0-review", kind: "skill-draft",
    content: {
      name: "review-artifacts", version: "1.1.0", documentHash: sha256(readFileSync(document)),
      activityKey: "review-artifacts", tests: ["tests\\skills.test.ts"], examples: 2, reviewNotes: "Explicit test reviewer decision",
    },
  });
  f.store.recordDecision({ artifactId: draft.id, version: draft.version, gate: "skill-review", decision: "approved" });
  await f.registry.load();
  assert.equal(f.registry.pin("review-artifacts").version, "1.1.0");
  assert.equal(f.registry.pinned(pin).pin.version, "1.0.0");
  assert.equal(f.store.listSkillInvocations("old-job")[0]?.pin.documentHash, pin.documentHash);
});

test("registry rejects unallowlisted adapters and malformed/missing contract examples", async (t) => {
  const f = await fixture(t, true);
  const metadata = join(f.root, "review-artifacts", "artefact.yaml");
  const original = readFileSync(metadata, "utf8");
  writeFileSync(metadata, original.replace("version: 1.0.0", "version: 1.2.0").replace("id: studio.review-artifacts", "id: generated.shell"));
  await assert.rejects(f.registry.load(), /not explicitly allowlisted/);
  writeFileSync(metadata, original.replace("version: 1.0.0", "version: 1.3.0").replace("checked: 0", "checked: 7"));
  await assert.rejects(f.registry.load(), /example failed/);
  writeFileSync(metadata, original.replace("version: 1.0.0", "version: 1.4.0").replace("activityKeys: [review-artifacts, review-scene]", "activityKeys: [source-broll]"));
  await assert.rejects(f.registry.load(), /claimed activities are not supported/);
});

test("invalid invocation input/output never records a successful validated outcome", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.registry.invoke(f.registry.pin("review-artifacts"), { subject: 17, artifacts: [] }, {
    jobId: "validation-job", stageId: "review", invocationKey: "scene", attempt: 1,
  }));
  assert.equal(f.store.listSkillInvocations("validation-job")[0]?.outcome, "failed");
});

test("external gauntlet stays prompt-only, source-pinned and licensed", async (t) => {
  const f = await fixture(t);
  const pin = f.registry.pin("gauntlet-loop");
  assert.equal(pin.promptOnly, true);
  const snapshot = f.registry.pinned(pin);
  assert.match(JSON.stringify(snapshot.metadata), new RegExp(GAUNTLET_COMMIT));
  assert.match(snapshot.files["LICENSE.TXT"]!, /Attribution/);
  await assert.rejects(f.registry.invoke(pin, {}, { jobId: "x", stageId: "x", invocationKey: "x", attempt: 1 }), /prompt, not executable authority/);
});

test("dry-run draft tests never self-approve a new skill, and runtime outputs are validated", async (t) => {
  let invalidOutput = false;
  const local: LocalSkillAdapter = {
    ...reviewArtifactsAdapter, id: "test.review-fixture", activityKeys: ["review-fixture"],
    execute: (input, context) => invalidOutput ? { checked: "not a number" } : reviewArtifactsAdapter.execute(input, context),
  };
  const f = await fixture(t, true, [local]);
  const candidate = join(f.root, "review-fixture");
  cpSync(join(f.root, "review-artifacts"), candidate, { recursive: true });
  const document = join(candidate, "SKILL.md");
  writeFileSync(document, readFileSync(document, "utf8").replace("name: review-artifacts", "name: review-fixture").replaceAll("studio.review-artifacts", local.id));
  const metadata = join(candidate, "artefact.yaml");
  writeFileSync(metadata, readFileSync(metadata, "utf8")
    .replace("name: review-artifacts", "name: review-fixture")
    .replace("activityKeys: [review-artifacts, review-scene]", "activityKeys: [review-fixture]")
    .replace("id: studio.review-artifacts", `id: ${local.id}`));
  const checked = await f.registry.load({ dryRun: true });
  assert(checked.some((pin) => pin.name === "review-fixture"));
  assert.equal(f.store.getSkillSnapshot("review-fixture", "1.0.0"), undefined);
  await assert.rejects(f.registry.load(), /independent current skill-review decision/);
  const draft = f.store.saveArtifact({
    id: "draft-review-fixture", kind: "skill-draft",
    content: { name: "review-fixture", version: "1.0.0", documentHash: sha256(readFileSync(document)), activityKey: "review-fixture", tests: ["tests\\skills.test.ts"], examples: 2, reviewNotes: "Explicit independent test review" },
  });
  f.store.recordDecision({ artifactId: draft.id, version: draft.version, gate: "skill-review", decision: "approved" });
  await f.registry.load();
  invalidOutput = true;
  await assert.rejects(f.registry.invoke(f.registry.pin("review-fixture"), { subject: "runtime check", artifacts: [] }, {
    jobId: "invalid-output-job", stageId: "review", invocationKey: "one", attempt: 1,
  }));
  assert.equal(f.store.listSkillInvocations("invalid-output-job")[0]?.outcome, "failed");
});

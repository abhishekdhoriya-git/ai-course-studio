import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { startStudioServer } from "../src/server.js";
import { artifactSchemas, relativePathSchema } from "../src/domain/schemas.js";
import type { ReviewState } from "../src/review-contract.js";
import { createFixtureAdapters } from "../src/media/pipeline.js";
import { currentFixture, fixtureGates, saveFixturePlan } from "../src/fixture.js";

async function setup(t: TestContext, withRenderer = false) {
  const data = `.studio\\review-tests\\${randomUUID()}`;
  const server = await startStudioServer({ port: 0, dataDirectory: data, ...(withRenderer ? { fixtureAdapters: createFixtureAdapters } : {}) });
  t.after(async () => { await server.close(); rmSync(join(process.cwd(), data), { recursive: true, force: true }); });
  const read = async () => (await (await fetch(`${server.url}/api/state`)).json()) as ReviewState;
  const state = await read();
  const post = (path: string, value: unknown, token = state.token) => fetch(`${server.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: server.url, "X-Studio-Token": token }, body: JSON.stringify(value),
  });
  return { server, read, post };
}

test("local review UI boots, blocks cross-origin/forged mutations, and never exposes a worker lease token", async (t) => {
  const f = await setup(t);
  const html = await fetch(f.server.url);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Load engineering fixture/);
  assert.match(html.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal((await f.post("/api/fixture", {}, "forged")).status, 403);
  const cross = await fetch(`${f.server.url}/api/fixture`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://unrelated.invalid", "X-Studio-Token": f.server.app.token }, body: "{}",
  });
  assert.equal(cross.status, 403);
  assert.equal((await f.post("/api/fixture", {})).status, 201);
  const state = await f.read();
  assert.equal(state.fixture?.gates.filter((gate) => gate.approved).length, 0);
  assert(state.jobs.every((job) => !("leaseToken" in job)));
  assert.equal((await f.post("/api/fixture/render", {})).status, 400);
  assert.equal((await f.post("/api/publish", {})).status, 404);
});

test("review edits enforce optimistic versions and invalidate approvals instead of silently overwriting", async (t) => {
  const f = await setup(t);
  await f.post("/api/fixture", {});
  const before = await f.read();
  const scene = before.artifacts.find((artifact) => artifact.id === "fixture:scene:gates")!;
  const storyboard = before.artifacts.find((artifact) => artifact.id === "fixture:storyboard")!;
  assert.equal((await f.post("/api/decisions", { artifactId: storyboard.id, version: storyboard.version, gate: "script-storyboard", decision: "approved" })).status, 200);
  const content = { ...scene.content, script: "A deliberately revised fixture explanation." };
  assert.equal((await f.post("/api/artifacts", { id: scene.id, kind: scene.kind, content, expectedVersion: scene.version, dependencies: scene.dependencies })).status, 201);
  assert.equal((await f.post("/api/artifacts", { id: scene.id, kind: scene.kind, content, expectedVersion: scene.version })).status, 409);
  assert.equal((await f.post("/api/decisions", { artifactId: storyboard.id, version: storyboard.version, gate: "script-storyboard", decision: "approved" })).status, 409);
  const after = await f.read();
  assert.equal(after.fixture?.gates.find((gate) => gate.gate === "script-storyboard")?.approved, false);
  assert(after.artifacts.some((artifact) => artifact.id === storyboard.id && artifact.version === 2));
  assert.equal(f.server.app.store.latestArtifact("fixture:scene:disclosure")?.version, 1);
});

test("asset paths reject absolute paths, traversal, control characters and Windows alternate data streams", () => {
  for (const path of ["C:\\private\\voice.wav", "..\\voice.wav", ".studio\\asset:secret", ".studio\\asset\u0000.wav"]) {
    assert.equal(relativePathSchema.safeParse(path).success, false);
  }
  assert.equal(relativePathSchema.safeParse(".studio\\media\\fixture.wav").success, true);
});

test("unsupported fixture visuals pause explicitly before any speech or media is generated", async (t) => {
  const f = await setup(t, true);
  await f.server.app.loadFixture();
  const scene = f.server.app.store.latestArtifact("fixture:scene:gates")!;
  f.server.app.saveArtifact({
    id: scene.id, kind: scene.kind, content: { ...scene.content, visual: "A different, unimplemented visual replacement." },
    expectedVersion: scene.version, dependencies: scene.dependencies,
  });
  for (const gate of fixtureGates(f.server.app.store, currentFixture(f.server.app.store)!)) f.server.app.store.recordDecision({
    artifactId: gate.ref.id, version: gate.ref.version, gate: gate.gate, decision: "approved",
    note: "Isolated contract test only.",
  });
  const jobId = f.server.app.renderFixture();
  await f.server.app.drain();
  const job = f.server.app.store.getJob(jobId)!;
  assert.equal(job.status, "paused");
  assert.match(job.reason!, /FIXTURE_VISUAL_UNSUPPORTED/);
  assert.equal(f.server.app.store.listArtifacts({ kind: "audio" }).length, 0);
  assert.equal(f.server.app.store.latestArtifact("fixture:output"), undefined);
});

test("updating an old fixture animation pack through the UI creates a new unapproved style, preserving the other input gates", async (t) => {
  const f = await setup(t, true);
  await f.server.app.loadFixture();
  const plan = currentFixture(f.server.app.store)!;
  const style = f.server.app.store.getArtifact(plan.style);
  const legacy = f.server.app.store.saveArtifact({
    id: plan.style.id, kind: "style-pack",
    content: { ...artifactSchemas["style-pack"].parse(style.content), templateVersion: "1.0.0" },
    dependencies: style.dependencies,
  });
  const old = { ...plan, style: legacy };
  saveFixturePlan(f.server.app.store, old);
  for (const gate of fixtureGates(f.server.app.store, old)) f.server.app.store.recordDecision({
    artifactId: gate.ref.id, version: gate.ref.version, gate: gate.gate, decision: "approved",
  });
  const before = await f.read();
  assert.equal(before.fixture?.needsTemplateUpdate, true);
  assert.equal(before.fixture?.readyToRender, false);
  assert.equal((await f.post("/api/fixture/render", {})).status, 400);
  assert.equal((await f.post("/api/fixture", {})).status, 201);
  const after = await f.read();
  assert.equal(after.fixture?.needsTemplateUpdate, false);
  assert.equal(after.fixture?.readyToRender, false);
  const pending = after.fixture!.gates.filter((gate) => !gate.approved);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.ref.id, plan.style.id);
  assert.equal(pending[0]?.ref.version, legacy.version + 1);
  assert.equal(f.server.app.store.isApproved(legacy, "style"), false);
});

test("an approved curriculum-title edit can rebuild linked review drafts without losing scene edits or copying approvals", async (t) => {
  const f = await setup(t, true);
  await f.server.app.loadFixture();
  const editedScene = f.server.app.store.latestArtifact("fixture:scene:gates")!;
  const script = "An authored test correction that must survive curriculum relinking.";
  f.server.app.saveArtifact({
    id: editedScene.id, kind: "scene", content: { ...editedScene.content, script },
    dependencies: editedScene.dependencies, expectedVersion: editedScene.version,
  });
  const before = currentFixture(f.server.app.store)!;
  for (const gate of fixtureGates(f.server.app.store, before)) f.server.app.store.recordDecision({
    artifactId: gate.ref.id, version: gate.ref.version, gate: gate.gate, decision: "approved",
  });
  const curriculum = f.server.app.store.getArtifact(before.curriculum);
  const title = "A revised test-only course outline title";
  f.server.app.saveArtifact({
    id: curriculum.id, kind: "curriculum", content: { ...curriculum.content, title },
    dependencies: curriculum.dependencies, expectedVersion: curriculum.version,
  });
  const changed = f.server.app.store.latestArtifact(curriculum.id)!;
  f.server.app.store.recordDecision({ artifactId: changed.id, version: changed.version, gate: "curriculum", decision: "approved" });
  const stale = await f.read();
  assert.equal(stale.fixture?.needsDependencyRepair, true);
  assert.equal(stale.fixture?.readyToRender, false);
  assert.equal((await f.post("/api/fixture", {})).status, 201);
  const next = currentFixture(f.server.app.store)!;
  assert.equal(next.curriculum.version, changed.version);
  assert.equal(artifactSchemas.curriculum.parse(f.server.app.store.getArtifact(next.curriculum).content).title, title);
  assert.equal(next.lesson.version, before.lesson.version + 1);
  assert.equal(next.storyboard.version, before.storyboard.version + 1);
  assert.equal(artifactSchemas.lesson.parse(f.server.app.store.getArtifact(next.lesson).content).curriculum.hash, changed.hash);
  assert.equal(artifactSchemas.scene.parse(f.server.app.store.latestArtifact(editedScene.id)!.content).script, script);
  const pending = fixtureGates(f.server.app.store, next).filter((gate) => !gate.approved);
  assert.deepEqual(pending.map((gate) => gate.gate), ["lesson", "script-storyboard"]);
  assert.equal(f.server.app.store.isApproved(next.curriculum, "curriculum"), true);
  assert.equal(f.server.app.store.isApproved(next.style, "style"), true);
  assert.equal(f.server.app.store.isApproved(next.lesson, "lesson"), false);
  assert.equal(f.server.app.store.isApproved(next.storyboard, "script-storyboard"), false);
  assert.equal((await f.read()).fixture?.needsDependencyRepair, false);
  assert.equal((await f.post("/api/fixture/render", {})).status, 400);
  const newPlanning = f.server.app.store.listJobs().findLast((job) => job.workflowId === "course-planning");
  assert(newPlanning?.input.artifacts.some((ref) => ref.id === changed.id && ref.hash === changed.hash));
  assert.equal((await f.post("/api/fixture", {})).status, 201);
  assert.equal(currentFixture(f.server.app.store)?.storyboard.version, next.storyboard.version);
});

test("structural curriculum changes remain explicit blockers without discarding authored edits", async (t) => {
  const f = await setup(t);
  await f.server.app.loadFixture();
  const before = currentFixture(f.server.app.store)!;
  const record = f.server.app.store.getArtifact(before.curriculum);
  const content = artifactSchemas.curriculum.parse(record.content);
  const changed = f.server.app.saveArtifact({
    id: record.id, kind: "curriculum",
    content: { ...content, lessons: [...content.lessons, { id: "another-lesson", title: "Authored extra lesson", objective: "New outcome", prerequisites: [] }] },
    dependencies: record.dependencies, expectedVersion: record.version,
  });
  const response = await f.post("/api/fixture", {});
  assert.equal(response.status, 400);
  assert.match(await response.text(), /lessons, sources or prerequisites changed/);
  assert.equal(f.server.app.store.latestArtifact(record.id)?.hash, changed.hash);
  assert.equal(f.server.app.store.latestArtifact(before.lesson.id)?.version, before.lesson.version);
  assert.equal(f.server.app.store.latestArtifact(before.storyboard.id)?.version, before.storyboard.version);
  assert.equal((await f.read()).fixture?.needsDependencyRepair, true);
});

test("storyboard-only script edits are preserved as a conflict rather than overwritten from older scene records", async (t) => {
  const f = await setup(t);
  await f.server.app.loadFixture();
  const before = currentFixture(f.server.app.store)!;
  const record = f.server.app.store.getArtifact(before.storyboard);
  const content = artifactSchemas["script-storyboard"].parse(record.content);
  const authored = "A storyboard-only correction that must not be discarded.";
  const changed = f.server.app.saveArtifact({
    id: record.id, kind: "script-storyboard",
    content: { ...content, scenes: content.scenes.map((scene, index) => index === 0 ? { ...scene, script: authored } : scene) },
    dependencies: record.dependencies, expectedVersion: record.version,
  });
  const response = await f.post("/api/fixture", {});
  assert.equal(response.status, 400);
  assert.match(await response.text(), /storyboard and individual scene scripts differ/);
  const latest = f.server.app.store.latestArtifact(record.id)!;
  assert.equal(latest.hash, changed.hash);
  assert.equal(artifactSchemas["script-storyboard"].parse(latest.content).scenes[0]?.script, authored);
  assert.equal(f.server.app.store.latestArtifact(before.lesson.id)?.version, before.lesson.version);
});

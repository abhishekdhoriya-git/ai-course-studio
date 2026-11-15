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

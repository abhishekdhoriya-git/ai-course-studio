import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { startStudioServer } from "../src/server.js";
import { relativePathSchema } from "../src/domain/schemas.js";
import type { ReviewState } from "../src/review-contract.js";

async function setup(t: TestContext) {
  const data = `.studio\\review-tests\\${randomUUID()}`;
  const server = await startStudioServer({ port: 0, dataDirectory: data });
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

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StudioApp } from "../src/app.js";
import { createFixtureAdapters } from "../src/media/pipeline.js";
import { artifactSchemas } from "../src/domain/schemas.js";
import { currentFixture, fixtureGates } from "../src/fixture.js";
import { TransientError } from "../src/domain/errors.js";
import { mediaCheckSchema } from "../src/media/contracts.js";

const root = process.cwd();
const dataDirectory = `.studio\\verification\\render-test-${randomUUID()}`;
const folder = join(root, ...dataDirectory.split("\\"));
mkdirSync(folder, { recursive: true });
const source = new DatabaseSync(join(root, ".studio", "verification", "studio.sqlite"), { readOnly: true });
try { await backup(source, join(folder, "studio.sqlite")); } finally { source.close(); }
let app = await StudioApp.open({ dataDirectory, fixtureAdapters: createFixtureAdapters });
try {
  const output = app.store.latestArtifact("fixture:output");
  if (!output) throw new Error("Run render:fixture -- --verification first; no actual source render exists.");
  const originalRef = { id: output.id, version: output.version, hash: output.hash };
  const originals = new Map(currentFixture(app.store)!.scenes.map((ref) => {
    const scene = artifactSchemas.scene.parse(app.store.getArtifact(ref).content);
    const asset = app.store.latestArtifact(`fixture:audio-asset:${scene.sceneId}`)!;
    return [scene.sceneId, { version: asset.version, hash: asset.hash, sha256: artifactSchemas.asset.parse(asset.content).sha256 }];
  }));
  app.store.recordDecision({
    artifactId: output.id, version: output.version, gate: "fixture-review", decision: "approved",
    note: "COPIED INTEGRATION TEST ONLY: simulated final fixture acceptance for unchanged-output reuse. Not owner acceptance.",
  });
  const same = app.renderFixture();
  await app.drain();
  assert.equal(app.store.getJob(same)?.status, "completed");
  assert.equal(app.store.latestArtifact(output.id)?.version, output.version);
  assert.equal(app.store.isApproved(originalRef, "fixture-review"), true);

  const scene = app.store.latestArtifact("fixture:scene:gates")!;
  const content = artifactSchemas.scene.parse(scene.content);
  app.saveArtifact({
    id: scene.id, kind: "scene", content: { ...content, script: `${content.script} A replacement needs a renewed review.` },
    dependencies: scene.dependencies, expectedVersion: scene.version,
  });
  assert.equal(app.store.isApproved(originalRef, "fixture-review"), false);
  for (const gate of fixtureGates(app.store, currentFixture(app.store)!)) {
    if (!gate.approved) app.store.recordDecision({
      artifactId: gate.ref.id, version: gate.ref.version, gate: gate.gate, decision: "approved",
      note: "COPIED INTEGRATION TEST ONLY: simulated revised fixture preflight.",
    });
  }
  await app.close();
  app = await StudioApp.open({
    dataDirectory,
    fixtureAdapters: (store, workspace, registry) => createFixtureAdapters(store, workspace, registry).map((adapter) =>
      adapter.id === "studio.fixture-render" ? {
        ...adapter, execute: async () => { throw new TransientError("INJECTED_PRE_RENDER", "Test-only transient interruption before the actual render."); },
      } : adapter),
  });
  const jobId = app.renderFixture();
  await app.drain();
  const interrupted = app.store.getJob(jobId)!;
  assert.equal(interrupted.status, "retry-wait");
  assert.equal(interrupted.stages.find((stage) => stage.id === "narration-presenter")?.attempts, 1);
  const invocationCount = app.store.listSkillInvocations(jobId).length;
  await app.close();
  app = await StudioApp.open({ dataDirectory, fixtureAdapters: createFixtureAdapters });
  const pending = app.store.getJob(jobId)!;
  await new Promise((accept) => setTimeout(accept, Math.max(0, (pending.nextAttemptAt ?? 0) - Date.now())));
  const resumed = await app.controller.run(jobId);
  assert.equal(resumed.status, "paused", resumed.reason ?? "");
  assert.match(resumed.reason!, /fixture-review/);
  assert.equal(resumed.stages.find((stage) => stage.id === "narration-presenter")?.attempts, 1);
  assert.equal(resumed.stages.find((stage) => stage.id === "render-and-checks")?.attempts, 2);
  assert.equal(app.store.listSkillInvocations(jobId).length, invocationCount);
  const revisedOutput = app.store.latestArtifact("fixture:output")!;
  assert.equal(app.store.isApproved(revisedOutput, "fixture-review"), false);
  let reused = 0;
  for (const [id, previous] of originals) {
    const asset = app.store.latestArtifact(`fixture:audio-asset:${id}`)!;
    const current = artifactSchemas.asset.parse(asset.content);
    if (id === "gates") assert.notEqual(current.sha256, previous.sha256);
    else {
      assert.equal(current.sha256, previous.sha256); assert.equal(asset.version, previous.version); assert.equal(asset.hash, previous.hash);
      reused++;
    }
  }
  assert.equal(reused, 3);
  const check = mediaCheckSchema.parse(artifactSchemas["workflow-report"].parse(app.store.latestArtifact("fixture:media-checks")!.content).data["mediaCheck"]);
  const result = {
    testHarnessOnly: true, unchangedApprovedOutputPreserved: true, changedAudioRegenerated: true,
    unchangedSceneAssetsReused: reused, resumeDidNotRepeatNarrationOrSkills: true,
    finalReviewStillRequired: true, actualRevisedDurationMs: check.durationMs, cueCount: check.subtitleCueCount,
  };
  mkdirSync(join(root, ".studio", "quality"), { recursive: true });
  writeFileSync(join(root, ".studio", "quality", "render-revision-resume.json"), JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app.close();
  rmSync(folder, { recursive: true, force: true });
}

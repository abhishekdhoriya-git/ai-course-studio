import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { StudioStore } from "../src/storage/store.js";
import { currentFixture, fixtureGates, fixtureNeedsTemplateUpdate, prepareFixture } from "../src/fixture.js";
import { artifactSchemas } from "../src/domain/schemas.js";
import { fixtureTemplate } from "../src/media/recipe.js";
import { validateRenderManifest } from "../src/media/composition.js";
import type { RenderManifest } from "../src/media/contracts.js";

function fixture(t: TestContext) {
  const root = join(process.cwd(), ".studio", "template-tests", randomUUID());
  mkdirSync(join(root, "src"), { recursive: true });
  cpSync(join(process.cwd(), "src", "media"), join(root, "src", "media"), { recursive: true });
  const store = new StudioStore(join(root, "test.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store };
}

test("changed animation code requires a new reviewed style and invalidates derived output, not narration or storyboard", (t) => {
  const { root, store } = fixture(t);
  const plan = prepareFixture(store, root);
  for (const gate of fixtureGates(store, plan)) store.recordDecision({
    artifactId: gate.ref.id, version: gate.ref.version, gate: gate.gate, decision: "approved",
  });
  const audio = store.saveArtifact({
    id: "unchanged-scene-audio", kind: "workflow-report",
    content: { summary: "Existing measured narration" }, dependencies: [plan.scenes[0]!],
  });
  const rendered = store.saveArtifact({
    id: "existing-render", kind: "workflow-report", content: { summary: "Previous template output" }, dependencies: [plan.style, audio],
  });
  store.recordDecision({ artifactId: rendered.id, version: rendered.version, gate: "fixture-review", decision: "approved" });
  const before = fixtureTemplate(root);
  appendFileSync(join(root, "src", "media", "motion.ts"), "\n// Changed test-fixture animation implementation.\n", "utf8");
  assert.notEqual(fixtureTemplate(root).sourceHash, before.sourceHash);
  assert.equal(fixtureNeedsTemplateUpdate(store, root, plan), true);
  const next = prepareFixture(store, root);
  assert.equal(next.style.version, plan.style.version + 1);
  assert.equal(store.isApproved(next.style, "style"), false);
  assert.equal(store.isCurrent(rendered), false);
  assert.equal(store.isApproved(rendered, "fixture-review"), false);
  assert.equal(store.isCurrent(audio), true);
  assert.equal(store.isApproved(plan.storyboard, "script-storyboard"), true);
  assert.equal(store.isApproved(plan.lesson, "lesson"), true);
  assert.equal(store.isApproved(plan.curriculum, "curriculum"), true);
  assert.deepEqual(next.scenes, plan.scenes);
  const style = artifactSchemas["style-pack"].parse(store.getArtifact(next.style).content);
  assert.equal(style.parameters["templateHash"], fixtureTemplate(root).sourceHash);
  assert.equal(fixtureNeedsTemplateUpdate(store, root, next), false);
  assert.deepEqual(prepareFixture(store, root), next);
  assert.deepEqual(currentFixture(store), next);
});

test("render media processing changes also invalidate the recipe instead of reusing an unchanged static manifest", (t) => {
  const { root, store } = fixture(t);
  const plan = prepareFixture(store, root);
  const old = fixtureTemplate(root);
  appendFileSync(join(root, "src", "media", "pipeline.ts"), "\n// Changed test-fixture render processing.\n", "utf8");
  const changed = fixtureTemplate(root);
  assert.notEqual(changed.sourceHash, old.sourceHash);
  assert.equal(fixtureNeedsTemplateUpdate(store, root, plan), true);
  assert.notEqual(prepareFixture(store, root).style.hash, plan.style.hash);
});

test("composition rejects bad measured word clocks while old caption-only manifests remain readable", () => {
  const manifest: RenderManifest = {
    fixture: true, title: "Test", disclosure: "ENGINEERING FIXTURE / NON-CLONED PRESENTER & VOICE",
    width: 1280, height: 720, fps: 24,
    scenes: [{
      id: "gates", title: "Test", purpose: "Actual timing validation", script: "Two words", layout: "gates",
      durationFrames: 240, audioPath: "audio/local.wav", captions: [{ startMs: 100, endMs: 2000, text: "Two words" }],
      wordTimings: [{ text: "Two", startMs: 100 }, { text: "words", startMs: 1500 }],
    }],
  };
  assert.equal(validateRenderManifest(manifest), manifest);
  const scene = manifest.scenes[0]!;
  assert.throws(() => validateRenderManifest({ ...manifest, scenes: [{ ...scene, wordTimings: [{ text: "late", startMs: 20000 }] }] }), /word timings/);
  assert.throws(() => validateRenderManifest({
    ...manifest, scenes: [{ ...scene, wordTimings: [{ text: "first", startMs: 800 }, { text: "second", startMs: 200 }] }],
  }), /word timings/);
  const { wordTimings: _words, ...legacy } = scene;
  assert.doesNotThrow(() => validateRenderManifest({ ...manifest, scenes: [legacy] }));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { RenderScene } from "../src/media/contracts.js";
import { createSceneMotionPlan, findSpeechAnchor, gateVersionPosition, revealProgress, sceneMotionState } from "../src/media/motion.js";
import type { MotionBeat, SceneMotionPlan, SceneMotionState } from "../src/media/motion.js";

function timedScene(layout: RenderScene["layout"], events: readonly (readonly [string, number])[], durationFrames = 480): RenderScene {
  const script = events.map(([text]) => text).join(" ");
  return {
    id: layout, title: layout, purpose: "Motion regression", layout, script, durationFrames, audioPath: "audio/fixture.wav",
    captions: [{ text: script, startMs: 0, endMs: durationFrames * 1000 / 24 }],
    wordTimings: events.map(([text, startMs]) => ({ text, startMs })),
  };
}

function beats(plan: SceneMotionPlan): MotionBeat[] {
  const heading = Object.values(plan.heading);
  switch (plan.layout) {
    case "intro": return [...heading, plan.presenter, ...plan.points];
    case "gates": return [...heading, ...plan.cards, ...plan.links, plan.version, plan.renewal];
    case "revision": return [...heading, ...plan.nodes, plan.sibling, plan.summary];
    case "skills": return [...heading, ...plan.items, plan.fourth, plan.route, plan.direct, ...plan.exclusions];
  }
}

function visibleStages(state: SceneMotionState): number[] {
  const heading = Object.values(state.heading);
  switch (state.layout) {
    case "intro": return [...heading, state.presenter, ...state.points];
    case "gates": return [...heading, ...state.cards, ...state.links, state.version, state.renewal];
    case "revision": return [...heading, ...state.nodes, state.sibling, state.summary];
    case "skills": return [...heading, ...state.items, state.fourth, state.route, state.direct, ...state.exclusions];
  }
}

test("phrase anchors use contiguous normalized speech events, or the real legacy cue start", () => {
  const scene = timedScene("intro", [
    ["ORIGINAL,", 120], ["style.", 1900], ["Local", 2200], ["unrelated", 2500], ["synthetic", 3100], ["voice.", 4100],
  ]);
  const anchor = findSpeechAnchor(scene, "original style");
  assert.equal(anchor?.startMs, 120);
  assert.equal(anchor?.source, "word");
  assert.equal(anchor?.text, "original style");
  assert.equal(findSpeechAnchor(scene, "local synthetic voice"), undefined);
  assert.equal(findSpeechAnchor(scene, "synthetic voice")?.startMs, 3100);

  const legacy = timedScene("intro", [["Unspoken", 0]]);
  delete legacy.wordTimings;
  legacy.captions = [{ startMs: 1350, endMs: 6000, text: "The original style is reviewed." }];
  assert.equal(findSpeechAnchor(legacy, "original style")?.startMs, 1350);
  assert.equal(findSpeechAnchor(legacy, "original style")?.source, "caption");
  legacy.captions = [
    { startMs: 100, endMs: 1000, text: "Original" }, { startMs: 1100, endMs: 2000, text: "Unrelated style" },
  ];
  assert.equal(findSpeechAnchor(legacy, "original style"), undefined);
});

test("gates reveal in spoken order, not at the opening lesson mention, then move focus to renewed v2", () => {
  const scene = timedScene("gates", [
    ["This", 0], ["lesson", 120], ["has", 300], ["review", 700], ["gates.", 1000],
    ["Approve", 1700], ["the", 1750], ["curriculum,", 2500], ["original", 4000], ["style,", 4200],
    ["lesson,", 5500], ["and", 5600], ["storyboard", 7000], ["before", 7200], ["rendering.", 7300],
    ["Each", 8500], ["approval", 8700], ["belongs", 8900], ["to", 9050], ["one", 9200],
    ["exact", 9400], ["artifact", 9600], ["version,", 9900], ["not", 10400], ["to", 10600],
    ["every", 11000], ["future", 12000], ["edit.", 12300],
  ]);
  const plan = createSceneMotionPlan(scene, 24);
  assert(plan.layout === "gates");
  assert.deepEqual(plan.cards.map((card) => card.frame), [60, 96, 132, 168]);
  assert.equal(plan.cards[2]?.anchor?.startMs, 5500);
  assert.equal(plan.cards[2]?.source, "word");
  for (const [index, stage] of plan.cards.entries()) {
    const before = sceneMotionState(plan, stage.frame - 1);
    const after = sceneMotionState(plan, stage.frame + plan.revealFrames);
    assert(before.layout === "gates" && after.layout === "gates");
    assert.equal(before.cards[index], 0);
    assert.equal(after.cards[index], 1);
    assert.equal(after.focusedCard, index);
    assert(before.cards.slice(index).every((progress) => progress === 0));
  }
  const moving = sceneMotionState(plan, plan.cards[2]!.frame + 4);
  assert(moving.layout === "gates");
  assert(moving.focus > 1 && moving.focus < 2);
  assert.equal(moving.renewal, 0);
  assert.equal(revealProgress(plan.renewal.frame - 1, plan.renewal, plan.revealFrames), 0);
  const renewed = sceneMotionState(plan, plan.renewal.frame + plan.revealFrames);
  assert(renewed.layout === "gates");
  assert.equal(renewed.renewal, 1);
  assert(renewed.cards.every((progress) => progress === 1));
});

test("revision frames build distinct dependency states while the unaffected branch remains reusable", () => {
  const scene = timedScene("revision", [
    ["One", 0], ["change", 200], ["should", 500], ["not", 700], ["restart", 900], ["a", 1000], ["course.", 1200],
    ["Replacing", 2000], ["a", 2300], ["scene", 2600], ["invalidates", 3000], ["that", 3300], ["scene's", 3500],
    ["derived", 5000], ["audio,", 5300], ["captions,", 7000], ["and", 7500], ["final", 9000], ["composition.", 9300],
    ["Unaffected", 11000], ["scenes", 11200], ["remain", 11500], ["available", 12000], ["for", 12500], ["reuse.", 13000],
  ]);
  const plan = createSceneMotionPlan(scene, 24);
  assert(plan.layout === "revision");
  const early = sceneMotionState(plan, 75);
  const middle = sceneMotionState(plan, 190);
  const late = sceneMotionState(plan, 285);
  assert(early.layout === "revision" && middle.layout === "revision" && late.layout === "revision");
  assert.deepEqual(early.nodes, [1, 0, 0, 0]);
  assert.deepEqual(middle.nodes, [1, 1, 1, 0]);
  assert.deepEqual(late.nodes, [1, 1, 1, 1]);
  assert.equal(early.sibling, 1);
  assert.equal(middle.sibling, 1);
  assert.equal(late.sibling, 1);
  assert.equal(early.summary, 0);
  assert.equal(late.summary, 1);
  assert.deepEqual(sceneMotionState(plan, 190), middle);
  for (const stage of plan.nodes) assert.equal(revealProgress(stage.frame - 1, stage, plan.revealFrames), 0);
});

test("the moving version token travels below teaching cards and reaches its own renewal lane without crossing labels", () => {
  for (let focus = 0; focus <= 3; focus += 0.1) {
    const position = gateVersionPosition(focus, 0);
    assert(position.top >= 433, "The token must stay below card text throughout focus travel.");
    assert(position.top + 40 <= 485, "The token must stay above the renewal summary while following cards.");
  }
  for (let step = 0; step <= 20; step++) {
    const renewal = step / 20;
    const position = gateVersionPosition(3, renewal);
    if (renewal <= 0.6) assert(position.top + 43 <= 485);
    else assert(position.left > 1100, "Descend only after moving beyond the fixed v1 badge and arrow.");
    assert(position.top + 44 < 604, "The token cannot enter the caption-safe area.");
  }
  assert.deepEqual(gateVersionPosition(3, 1), { left: 1114, top: 500 });
});

test("three baseline items precede the spoken fourth; the later Three never removes it, and exclusions follow their words", () => {
  const scene = timedScene("skills", [
    ["Repeated", 0], ["work", 200], ["becomes", 500], ["a", 650], ["skill", 800], ["at", 1000],
    ["four", 2500], ["distinct", 3000], ["work", 3300], ["items", 3500], ["inside", 4000], ["one", 4300], ["video.", 4500],
    ["Three", 6000], ["do", 6200], ["not", 6500], ["trigger", 6900], ["extraction.", 7000],
    ["Retries,", 8000], ["polling,", 9500], ["frames,", 11000], ["and", 11300], ["resumed", 12000], ["duplicates", 12300],
  ]);
  const plan = createSceneMotionPlan(scene, 24);
  assert(plan.layout === "skills");
  assert.equal(plan.fourth.frame, 60);
  assert.equal(plan.direct.frame, 144);
  const baseline = sceneMotionState(plan, 59);
  assert(baseline.layout === "skills");
  assert.deepEqual(baseline.items, [1, 1, 1]);
  assert.equal(baseline.fourth, 0);
  assert.equal(baseline.route, 0);
  assert.equal(baseline.direct, 0);
  assert(baseline.exclusions.every((progress) => progress === 0));
  const fourth = sceneMotionState(plan, 75);
  const threeMention = sceneMotionState(plan, plan.direct.frame + plan.revealFrames);
  assert(fourth.layout === "skills" && threeMention.layout === "skills");
  assert.equal(fourth.fourth, 1);
  assert.equal(fourth.direct, 0);
  assert.equal(threeMention.fourth, 1);
  assert.equal(threeMention.direct, 1);
  assert.deepEqual(plan.exclusions.map((stage) => stage.frame), [192, 228, 264, 288]);
  for (const [index, stage] of plan.exclusions.entries()) {
    assert.equal(stage.source, "word");
    const before = sceneMotionState(plan, stage.frame - 1);
    const after = sceneMotionState(plan, stage.frame + plan.revealFrames);
    assert(before.layout === "skills" && after.layout === "skills");
    assert.equal(before.exclusions[index], 0);
    assert.equal(after.exclusions[index], 1);
  }
});

test("missing phrases stay explicit fallbacks before the next known gate, not after its speech", () => {
  const plan = createSceneMotionPlan(timedScene("gates", [
    ["review", 100], ["gates", 300], ["Approve", 700], ["original", 3000], ["style", 3400],
    ["lesson", 5000], ["storyboard", 7000], ["Each", 9000], ["approval", 9300], ["future", 12000], ["edit", 12300],
  ]), 24);
  assert(plan.layout === "gates");
  assert.equal(plan.cards[0]?.source, "fallback");
  assert(plan.cards[0]!.frame < plan.cards[1]!.frame);
  assert.equal(plan.cards[1]?.frame, 72);
  const missingNamedLesson = createSceneMotionPlan(timedScene("gates", [
    ["This", 0], ["lesson", 200], ["has", 400], ["review", 700], ["gates.", 900], ["Storyboard", 5000],
  ]), 24);
  assert(missingNamedLesson.layout === "gates");
  assert.equal(missingNamedLesson.cards[2]?.source, "fallback");
  assert.equal(missingNamedLesson.cards[2]?.anchor, undefined);
});

test("very short or revised scripts keep every reveal bounded and settled before the final hold", () => {
  for (const layout of ["intro", "gates", "revision", "skills"] as const) {
    for (const durationFrames of [1, 4, 18, 24, 48]) {
      const scene = timedScene(layout, [["Completely revised narration.", 0]], durationFrames);
      const plan = createSceneMotionPlan(scene, 24);
      for (const stage of beats(plan)) {
        assert(Number.isFinite(stage.frame));
        assert(stage.frame >= 0 && stage.frame <= plan.latestBeatFrame);
        assert.equal(stage.source, "fallback");
      }
      const settled = sceneMotionState(plan, plan.latestBeatFrame + plan.revealFrames);
      assert(visibleStages(settled).every((progress) => progress === 1), `${layout}, ${durationFrames} frames`);
      assert.equal(settled.opacity, 1);
      assert.deepEqual(createSceneMotionPlan(scene, 24), plan);
    }
  }
  const lateAnchors = createSceneMotionPlan(timedScene("gates", [
    ["Review", 0], ["gates.", 50], ["Approve", 70], ["curriculum,", 800], ["original", 820], ["style,", 850],
    ["lesson,", 900], ["storyboard.", 950], ["Each", 970], ["approval", 980], ["future", 990], ["edit.", 995],
  ], 24), 24);
  assert(beats(lateAnchors).every((stage) => stage.frame <= lateAnchors.latestBeatFrame));
  assert(visibleStages(sceneMotionState(lateAnchors, lateAnchors.latestBeatFrame + lateAnchors.revealFrames))
    .every((progress) => progress === 1));
});

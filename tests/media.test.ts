import assert from "node:assert/strict";
import { test } from "node:test";
import { alignSpeech, toSrt, toVtt, validateCues } from "../src/media/captions.js";
import { validateFixtureVideo } from "../src/media/tools.js";
import type { Probe } from "../src/media/tools.js";
import { fixtureSceneAdapter, fixtureSceneOutputSchema } from "../src/skills/adapters.js";
import { renderManifestSchema } from "../src/media/contracts.js";

test("caption groups use actual irregular speech events and final audio bounds, not word-count timing", () => {
  const words = ["One", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const starts = [300, 700, 900, 1800, 2300, 2600, 3300, 4100, 4900];
  const text = words.join(" ");
  let position = 0;
  const boundaries = words.map((word, index) => {
    const event = { text: word, startMs: starts[index]!, characterPosition: position, characterCount: word.length };
    position += word.length + 1; return event;
  });
  const aligned = alignSpeech({ voice: "Test synthetic engine", text, boundaries }, 6000);
  assert.equal(aligned.cues[0]?.startMs, 300);
  assert.equal(aligned.cues[0]?.endMs, 4900);
  assert.equal(aligned.cues[1]?.startMs, 4900);
  assert.equal(aligned.cues[1]?.endMs, 6000);
  assert.equal(aligned.transcript, text);
  assert.match(toSrt(aligned.cues), /00:00:00,300 --> 00:00:04,900/);
});

test("missing, mismatched or out-of-audio speech events fail rather than creating estimated captions", () => {
  const event = { text: "Hello", startMs: 50, characterPosition: 0, characterCount: 5 };
  assert.throws(() => alignSpeech({ voice: "test", text: "Different", boundaries: [event] }, 1000));
  assert.throws(() => alignSpeech({ voice: "test", text: "Hello", boundaries: [{ ...event, startMs: 1100 }] }, 1000));
  assert.throws(() => alignSpeech({ voice: "test", text: "Hello", boundaries: [] }, 1000));
});

test("captions reject overlap and final-audio overflow and escape VTT markup", () => {
  assert.throws(() => validateCues([{ startMs: 0, endMs: 600, text: "a" }, { startMs: 500, endMs: 900, text: "b" }], 1000));
  assert.throws(() => validateCues([{ startMs: 0, endMs: 1100, text: "a" }], 1000));
  assert.match(toVtt([{ startMs: 0, endMs: 1000, text: "<script> & text" }]), /&lt;script&gt; &amp; text/);
});

test("both export variants must satisfy exact dimensions, frame rate, streams and measured duration", () => {
  const valid: Probe = {
    streams: [{ codec_type: "video", codec_name: "h264", width: 1280, height: 720, r_frame_rate: "24/1" }, { codec_type: "audio", codec_name: "aac" }],
    format: { duration: "6.000" },
  };
  assert.equal(validateFixtureVideo(valid, 6000).durationMs, 6000);
  assert.throws(() => validateFixtureVideo({ ...valid, format: { duration: "2.000" } }, 6000));
  assert.throws(() => validateFixtureVideo({ ...valid, streams: [{ ...valid.streams[0]!, width: 640 }, valid.streams[1]!] }, 6000));
  assert.throws(() => validateFixtureVideo({ ...valid, streams: [{ ...valid.streams[0]!, r_frame_rate: "30/1" }, valid.streams[1]!] }, 6000));
  assert.throws(() => validateFixtureVideo({ ...valid, streams: [valid.streams[0]!] }, 6000));
});

test("fixture-scene skill validates a plan, never a fabricated generated asset or a real-presenter request", async () => {
  const input = {
    fixture: true, source: { id: "scene", version: 2, hash: "0".repeat(64) },
    scene: { videoId: "fixture", sceneId: "scene", purpose: "Contract test", script: "Hello", visual: "Original graphic", assets: [], activities: [] },
  };
  const output = fixtureSceneOutputSchema.parse(await fixtureSceneAdapter.execute(input, {
    jobId: "test", stageId: "contract", invocationKey: "plan", attempt: 1,
  }));
  assert.equal(output.status, "validated-plan");
  assert.equal(output.measuredAudioRequired, true);
  assert.equal(output.humanReviewRequired, true);
  assert(!("asset" in output));
  assert.throws(() => fixtureSceneAdapter.inputSchema.parse({ ...input, fixture: false }));
  assert.equal(renderManifestSchema.safeParse({ fixture: true, scenes: [] }).success, false);
});

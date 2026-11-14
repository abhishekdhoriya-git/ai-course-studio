import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderMedia, selectComposition } from "@remotion/renderer";
import { artifactSchemas, jsonSchema } from "../domain/schemas.js";
import type { ArtifactContent, ArtifactKind, ArtifactRef, SaveArtifactInput } from "../domain/schemas.js";
import { canonicalJson, hashJson, sha256File } from "../domain/hash.js";
import { MissingInputError, PolicyError, StudioError } from "../domain/errors.js";
import type { FixtureStageAdapter, StageAdapterContext } from "../controller.js";
import type { StageOutputRequest } from "../domain/runtime.js";
import type { StudioStore } from "../storage/store.js";
import type { SkillRegistry } from "../skills/registry.js";
import { fixtureSceneTemplates, requireFixtureGates } from "../fixture.js";
import {
  FIXTURE_MANIFEST_ID, FIXTURE_VIDEO_ID, fixturePlanSchema, mediaCheckSchema, renderManifestSchema, speechResultSchema,
} from "./contracts.js";
import type { CaptionCue, FixturePlan, MediaCheck, RenderManifest, RenderScene } from "./contracts.js";
import { alignSpeech, toAss, toSrt, toVtt, validateCues } from "./captions.js";
import { MediaTools, runMediaTool, validateFixtureVideo } from "./tools.js";

const sceneLayouts: Record<string, { title: string; layout: RenderScene["layout"] }> = {
  disclosure: { title: "Engineering fixture, not a pilot", layout: "intro" },
  gates: { title: "Exact-version approvals", layout: "gates" },
  revision: { title: "Selective invalidation", layout: "revision" },
  skills: { title: "Three versus four", layout: "skills" },
};
const toRef = ({ id, version, hash }: ArtifactRef): ArtifactRef => ({ id, version, hash });
const dataOf = (store: StudioStore, ref: ArtifactRef) => artifactSchemas["workflow-report"].parse(store.getArtifact(ref).content).data;

class FixturePipeline {
  private mediaTools: MediaTools | undefined;
  private get tools(): MediaTools { return this.mediaTools ??= new MediaTools(); }
  constructor(private readonly store: StudioStore, private readonly root: string, private readonly registry: SkillRegistry) {}

  private plan(context: StageAdapterContext): FixturePlan {
    context.signal.throwIfAborted();
    this.store.assertClaim(context.job.id, context.leaseToken);
    if (context.job.input.parameters["fixture"] !== true || context.job.input.videoId !== FIXTURE_VIDEO_ID) {
      throw new PolicyError("FIXTURE_ONLY", "This pipeline only creates a labeled non-cloned engineering fixture.");
    }
    const reference = context.job.input.artifacts.find((ref) => ref.id === FIXTURE_MANIFEST_ID);
    if (!reference) throw new MissingInputError("FIXTURE_MANIFEST", "Supply the exact current engineering-fixture manifest.");
    this.store.requireCurrent(reference);
    const plan = fixturePlanSchema.parse(dataOf(this.store, reference)["fixturePlan"]);
    requireFixtureGates(this.store, plan);
    const storyboard = artifactSchemas["script-storyboard"].parse(this.store.requireCurrent(plan.storyboard).content);
    const scenes = plan.scenes.map((ref) => artifactSchemas.scene.parse(this.store.requireCurrent(ref).content));
    if (canonicalJson(scenes) !== canonicalJson(storyboard.scenes) || scenes.some((scene) => !sceneLayouts[scene.sceneId] || scene.videoId !== plan.videoId)) {
      throw new StudioError("FIXTURE_SCENE_MISMATCH", "Scene versions must exactly match the approved fixture storyboard and supported original layouts.");
    }
    if (new Set(scenes.map((scene) => scene.sceneId)).size !== 4) throw new StudioError("FIXTURE_SCENE_MISMATCH", "The fixture requires four distinct scene work items.");
    if (scenes.some((scene) => scene.visual !== fixtureSceneTemplates.find((template) => template.sceneId === scene.sceneId)?.visual)) {
      throw new MissingInputError("FIXTURE_VISUAL_UNSUPPORTED", "The engineering fixture supports its original vector layouts and script revisions only. Install and review a new template/asset adapter for a visual replacement; it will not be silently ignored.");
    }
    const style = artifactSchemas["style-pack"].parse(this.store.requireCurrent(plan.style).content);
    if (style.templateVersion !== "1.0.0" || style.parameters["background"] !== "#101827"
      || style.parameters["accent"] !== "#68e8c5" || style.parameters["font"] !== "Arial") {
      throw new MissingInputError("STYLE_TEMPLATE_MISSING", "The installed fixture template supports the original starter palette/font only. Install and review a new template for another style.");
    }
    return plan;
  }

  private save<K extends ArtifactKind>(input: SaveArtifactInput<K>, context: StageAdapterContext): ArtifactRef {
    return this.store.atomic(() => {
      this.plan(context);
      return this.store.saveArtifact(input);
    });
  }
  private asset(id: string, path: string, type: string, dependencies: ArtifactRef[], context: StageAdapterContext, provenance: string): ArtifactRef {
    return this.save({
      id, kind: "asset",
      content: {
        path: relative(this.root, path), sha256: sha256File(path), mediaType: type, fixture: true,
        provenance, rights: "Original engineering fixture only. No identity, reference footage or third-party music. Confirm speech/media rights before commercial distribution.",
      },
      dependencies,
    }, context);
  }

  private current<K extends ArtifactKind>(id: string, kind: K): { ref: ArtifactRef; content: ArtifactContent<K> } {
    const record = this.store.latestArtifact(id);
    if (!record || record.kind !== kind || !this.store.isCurrent(record)) {
      throw new MissingInputError("FIXTURE_INPUT_MISSING", `Produce the actual current ${kind}: ${id}`);
    }
    return { ref: toRef(record), content: artifactSchemas[kind].parse(record.content) as ArtifactContent<K> };
  }
  private file(asset: ArtifactRef): string {
    const value = artifactSchemas.asset.parse(this.store.requireCurrent(asset).content);
    const file = resolve(this.root, ...value.path.split(/[\\/]/));
    if (!existsSync(file) || sha256File(file) !== value.sha256) throw new StudioError("FIXTURE_ASSET_CHANGED", `The actual fixture asset is missing or changed: ${value.path}`);
    return file;
  }

  async narration(context: StageAdapterContext): Promise<StageOutputRequest> {
    const plan = this.plan(context);
    if (process.platform !== "win32") throw new MissingInputError("LOCAL_SPEECH_UNAVAILABLE", "Install an authorized local speech adapter for this platform; the fixture currently uses Windows built-in speech.");
    const pin = context.job.skillPins.find((item) => item.name === "produce-fixture-scene");
    const reviewPin = context.job.skillPins.find((item) => item.name === "review-artifacts");
    if (!pin || !reviewPin) throw new MissingInputError("FIXTURE_SKILL_PIN", "Start a job pinned to the reviewed fixture-scene and structural-review skills.");
    const tracker = new (await import("../skills/repetition.js")).RepetitionTracker(this.store, this.registry);
    const scenes = plan.scenes.map((ref) => ({ ref, scene: artifactSchemas.scene.parse(this.store.requireCurrent(ref).content) }));
    tracker.preflight(["produce-fixture-scene", "review-scene"].map((activityKey) => ({
      videoId: plan.videoId, activityKey, workItemIds: scenes.map((item) => item.scene.sceneId),
    })), context.job.skillPins);
    const outputs: ArtifactRef[] = [];
    for (const { ref, scene } of scenes) {
      this.plan(context);
      for (const [activityKey, selected] of [["produce-fixture-scene", pin], ["review-scene", reviewPin]] as const) {
        const invocationKey = `${activityKey}:${scene.sceneId}:${ref.version}`;
        const completed = this.store.listSkillInvocations(context.job.id).some((invocation) =>
          invocation.invocationKey === invocationKey && invocation.outcome === "succeeded" && invocation.pin.packageHash === selected.packageHash);
        tracker.record({
          eventId: `${context.job.id}:${context.stage.id}:${context.attempt}:${activityKey}:${scene.sceneId}`,
          videoId: plan.videoId, activityKey, workItemId: scene.sceneId, kind: completed ? "resume" : "work-item", skill: selected,
        });
        if (!completed) await this.registry.invoke(selected, activityKey === "produce-fixture-scene"
          ? { fixture: true, source: ref, scene }
          : { subject: `Engineering fixture scene ${scene.sceneId}`, artifacts: [{ ref, kind: "scene", current: true }] },
        { jobId: context.job.id, stageId: context.stage.id, invocationKey, attempt: context.attempt, signal: context.signal });
      }
      const key = hashJson({ script: scene.script, speechAdapter: "windows-sapi-en-16k@1.0.0", profile: "loudnorm-I-18-TP-2-48k-mono" });
      const folder = join(this.root, ".studio", "speech", key);
      mkdirSync(folder, { recursive: true });
      const input = join(folder, "script.txt"); const raw = join(folder, "raw.wav");
      const boundaries = join(folder, "speech.json"); const normalized = join(folder, "narration.wav");
      if (!existsSync(raw) || !existsSync(boundaries)) {
        writeFileSync(input, scene.script, "utf8");
        await runMediaTool("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-File", join(this.root, "scripts", "narrate-fixture.ps1"),
          "-InputFile", input, "-OutputFile", raw, "-BoundaryFile", boundaries,
        ], { signal: context.signal, timeout: 30000 });
      }
      const speech = speechResultSchema.parse(JSON.parse(readFileSync(boundaries, "utf8")) as unknown);
      if (speech.text !== scene.script) throw new StudioError("SPEECH_CACHE_MISMATCH", "Cached speech belongs to a different exact script.");
      if (!existsSync(normalized)) await this.tools.normalizeAudio(raw, normalized, context.signal);
      const rawProbe = await this.tools.probe(raw, context.signal);
      if (rawProbe.streams[0]?.["sample_rate"] !== "16000") throw new StudioError("SPEECH_FORMAT", "The local speech-event clock requires an explicit 16 kHz PCM output.");
      const rawDuration = Number(rawProbe.format.duration) * 1000;
      const durationMs = await this.tools.durationMs(normalized, context.signal);
      if (Math.abs(durationMs - rawDuration) > 20) throw new StudioError("AUDIO_TIMELINE_CHANGED", "Normalization changed the speech timeline; realignment is required.");
      await this.tools.decode(normalized, context.signal);
      const aligned = alignSpeech(speech, durationMs);
      const asset = this.asset(`fixture:audio-asset:${scene.sceneId}`, normalized, "audio/wav", [ref], context,
        `Non-cloned local synthetic speech using ${speech.voice}; events and duration measured from the actual output.`);
      const audio = this.save({
        id: `fixture:audio:${scene.sceneId}`, kind: "audio",
        content: { sceneId: scene.sceneId, asset, durationMs, measured: true, transcript: aligned.transcript, fixture: true },
      }, context);
      const report = this.save({
        id: `fixture:speech:${scene.sceneId}`, kind: "workflow-report",
        content: {
          summary: "Actual local, non-cloned synthetic speech and measured word events; not an owner voice clone.",
          references: [audio], data: { speech: jsonSchema.parse(speech), durationMs },
        }, dependencies: [ref, audio],
      }, context);
      outputs.push(asset, audio, report);
    }
    const presenter = this.save({
      id: "fixture:presenter", kind: "presenter-sample",
      content: { asset: plan.poster, mode: "fixture", consentEvidence: "Original vector stand-in, not any person's likeness; no enrollment or identity data." },
    }, context);
    return { summary: "Created/reused 4 measured non-cloned narration scenes after pinned skill preflight.", references: [...outputs, presenter] };
  }

  async alignment(context: StageAdapterContext): Promise<StageOutputRequest> {
    const plan = this.plan(context);
    const outputs: ArtifactRef[] = [];
    for (const ref of plan.scenes) {
      const scene = artifactSchemas.scene.parse(this.store.requireCurrent(ref).content);
      const audio = this.current(`fixture:audio:${scene.sceneId}`, "audio");
      const speech = this.current(`fixture:speech:${scene.sceneId}`, "workflow-report");
      const result = speechResultSchema.parse(speech.content.data["speech"]);
      const aligned = alignSpeech(result, audio.content.durationMs);
      const key = hashJson({ audio: audio.ref, cues: aligned.cues, captionAdapter: "1.0.0" });
      const folder = join(this.root, ".studio", "captions", key);
      mkdirSync(folder, { recursive: true });
      const vtt = join(folder, "captions.vtt"); const srt = join(folder, "captions.srt");
      writeFileSync(vtt, toVtt(aligned.cues), "utf8"); writeFileSync(srt, toSrt(aligned.cues), "utf8");
      const timing = this.save({
        id: `fixture:timing:${scene.sceneId}`, kind: "timing", content: { sceneId: scene.sceneId, audio: audio.ref, segments: aligned.cues },
      }, context);
      const asset = this.asset(`fixture:caption-asset:${scene.sceneId}`, vtt, "text/vtt", [audio.ref, timing], context,
        "Caption timestamps derived from actual local synthetic speech events and measured final audio.");
      const captions = this.save({
        id: `fixture:captions:${scene.sceneId}`, kind: "captions",
        content: { sceneId: scene.sceneId, audio: audio.ref, timing, asset },
      }, context);
      outputs.push(timing, asset, captions);
    }
    return { summary: "Aligned scene captions to measured final audio; no word-count timing estimates.", references: outputs };
  }

  async composition(context: StageAdapterContext): Promise<StageOutputRequest> {
    const plan = this.plan(context);
    const sceneData: RenderScene[] = [];
    const audioRefs: ArtifactRef[] = []; const captionRefs: ArtifactRef[] = [];
    for (const ref of plan.scenes) {
      const scene = artifactSchemas.scene.parse(this.store.requireCurrent(ref).content);
      const audio = this.current(`fixture:audio:${scene.sceneId}`, "audio");
      const timing = this.current(`fixture:timing:${scene.sceneId}`, "timing");
      const captions = this.current(`fixture:captions:${scene.sceneId}`, "captions");
      const layout = sceneLayouts[scene.sceneId]!;
      const audioPath = `audio/${hashJson(audio.ref)}.wav`;
      sceneData.push({
        id: scene.sceneId, title: layout.title, layout: layout.layout, purpose: scene.purpose, script: scene.script,
        durationFrames: Math.ceil((audio.content.durationMs + 250) * plan.fps / 1000),
        audioPath, captions: timing.content.segments,
      });
      audioRefs.push(audio.ref); captionRefs.push(captions.ref);
    }
    const manifest: RenderManifest = {
      fixture: true, title: plan.title, width: plan.width, height: plan.height, fps: plan.fps,
      disclosure: plan.disclosure, scenes: sceneData, burnInCaptions: false,
    };
    const composition = this.save({
      id: "fixture:composition", kind: "composition",
      content: { videoId: plan.videoId, scenes: plan.scenes, audio: audioRefs, captions: captionRefs, style: plan.style },
      dependencies: [plan.storyboard],
    }, context);
    const report = this.save({
      id: "fixture:render-manifest", kind: "workflow-report",
      content: { summary: "Measured, versioned engineering-fixture composition; clean master plus separate captions.", references: [composition], data: { renderManifest: jsonSchema.parse(manifest) } },
    }, context);
    return { summary: "Composed 4 original, non-cloned fixture scenes using actual audio/caption timing.", references: [composition, report] };
  }

  async render(context: StageAdapterContext): Promise<StageOutputRequest> {
    const plan = this.plan(context);
    const composition = this.current("fixture:composition", "composition");
    const renderRecord = this.current("fixture:render-manifest", "workflow-report");
    // This data was produced by the installed typed composition stage, never by a model-generated module.
    const { validateRenderManifest } = await import("./composition.js");
    const manifest = validateRenderManifest(renderManifestSchema.parse(renderRecord.content.data["renderManifest"]));
    const key = hashJson({ manifest, remotion: "4.0.539", fixtureAdapter: "1.0.0" });
    const folder = join(this.root, ".studio", "exports", key);
    const publicDir = join(this.root, ".studio", "render-inputs", key, "public");
    mkdirSync(folder, { recursive: true }); mkdirSync(join(publicDir, "audio"), { recursive: true });
    const allCues: CaptionCue[] = [];
    const transcripts: string[] = [];
    let frames = 0;
    const voices = new Set<string>();
    for (const scene of manifest.scenes) {
      const audio = this.current(`fixture:audio:${scene.id}`, "audio");
      copyFileSync(this.file(audio.content.asset), join(publicDir, ...scene.audioPath.split("/")));
      const offsetMs = frames * 1000 / manifest.fps;
      allCues.push(...scene.captions.map((cue) => ({ ...cue, startMs: cue.startMs + offsetMs, endMs: cue.endMs + offsetMs })));
      transcripts.push(`${scene.title}\n${audio.content.transcript}`);
      frames += scene.durationFrames;
      const report = this.current(`fixture:speech:${scene.id}`, "workflow-report");
      voices.add(speechResultSchema.parse(report.content.data["speech"]).voice);
    }
    const expectedDurationMs = frames * 1000 / manifest.fps;
    validateCues(allCues, expectedDurationMs);
    const master = join(folder, "master.mp4"); const captioned = join(folder, "captioned.mp4");
    const srt = join(folder, "captions.srt"); const vtt = join(folder, "captions.vtt");
    const ass = join(folder, "captions.ass"); const transcript = join(folder, "transcript.txt");
    writeFileSync(srt, toSrt(allCues), "utf8"); writeFileSync(vtt, toVtt(allCues), "utf8"); writeFileSync(ass, toAss(allCues), "utf8");
    writeFileSync(transcript, `ENGINEERING FIXTURE / NON-CLONED PRESENTER & VOICE\n\nFinal spoken words from the local speech engine's output events, not an ASR/owner-voice claim.\n\n${transcripts.join("\n\n")}\n`, "utf8");
    const startedAt = Date.now();
    const temporary = join(folder, `r-${randomUUID().slice(0, 8)}.mp4`);
    const captionedTemporary = join(folder, `c-${randomUUID().slice(0, 8)}.mp4`);
    try {
      if (!existsSync(master)) {
        const serveUrl = await bundle({
          entryPoint: join(this.root, "src", "media", "entry.tsx"), publicDir, outDir: join(this.root, ".studio", "bundles", key),
          webpackOverride: (configuration) => ({
            ...configuration,
            resolve: { ...configuration.resolve, extensionAlias: { ...configuration.resolve?.extensionAlias, ".js": [".ts", ".tsx", ".js"] } },
          }),
        });
        const selected = await selectComposition({ serveUrl, id: "StudioFixture", inputProps: { manifest }, logLevel: "error" });
        const cancel = makeCancelSignal();
        const stop = () => cancel.cancel();
        context.signal.throwIfAborted();
        context.signal.addEventListener("abort", stop, { once: true });
        try {
          await renderMedia({
            serveUrl, composition: selected, inputProps: { manifest }, codec: "h264",
            audioCodec: "aac", crf: 19, pixelFormat: "yuv420p", concurrency: 2,
            outputLocation: temporary, logLevel: "error", cancelSignal: cancel.cancelSignal, isProduction: false,
          });
        } finally { context.signal.removeEventListener("abort", stop); }
        this.plan(context);
        const normalized = join(folder, `n-${randomUUID().slice(0, 8)}.mp4`);
        try {
          await runMediaTool(this.tools.ffmpeg, [
            "-hide_banner", "-loglevel", "error", "-y", "-i", temporary,
            "-c:v", "copy", "-af", "loudnorm=I=-18:TP=-2:LRA=7", "-c:a", "aac", "-b:a", "192k",
            "-ar", "48000", "-movflags", "+faststart", normalized,
          ], { signal: context.signal });
          await this.tools.decode(normalized, context.signal);
          renameSync(normalized, master);
        } finally { if (existsSync(normalized)) rmSync(normalized); }
      }
      if (!existsSync(captioned)) {
        await runMediaTool(this.tools.ffmpeg, [
          "-hide_banner", "-loglevel", "error", "-y", "-i", master,
          "-vf", "ass=filename=captions.ass", "-c:v", "libx264", "-crf", "19", "-preset", "veryfast",
          "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", captionedTemporary,
        ], { cwd: folder, signal: context.signal });
        validateFixtureVideo(await this.tools.probe(captionedTemporary, context.signal), expectedDurationMs);
        await this.tools.decode(captionedTemporary, context.signal);
        renameSync(captionedTemporary, captioned);
      }
      const probe = await this.tools.probe(master, context.signal);
      const { video, durationMs } = validateFixtureVideo(probe, expectedDurationMs);
      validateFixtureVideo(await this.tools.probe(captioned, context.signal), expectedDurationMs);
      const audioStreams = probe.streams.filter((stream) => stream.codec_type === "audio").length;
      await this.tools.decode(master, context.signal); await this.tools.decode(captioned, context.signal);
      const loudness = await this.tools.loudness(master, context.signal);
      const silenceOver2sCount = await this.tools.longSilences(master, context.signal);
      if (Math.abs(loudness.integratedLufs + 18) > 2 || loudness.truePeakDb > -1 || silenceOver2sCount !== 0) {
        throw new StudioError("AUDIO_VALIDATION", "Fixture speech must measure -18 LUFS +/-2, true peak <=-1 dBTP and no unexpected silence >=2 seconds.");
      }
      this.plan(context);
      const previousOutput = this.store.latestArtifact("fixture:output");
      const previousReport = this.store.latestArtifact("fixture:media-checks");
      const unchangedFiles = [
        ["fixture:media:master", master], ["fixture:media:captioned", captioned],
        ["fixture:media:srt", srt], ["fixture:media:vtt", vtt], ["fixture:media:transcript", transcript],
      ] as const;
      const unchanged = unchangedFiles.every(([id, file]) => {
        const record = this.store.latestArtifact(id);
        if (!record || record.kind !== "asset" || !this.store.isCurrent(record)) return false;
        const content = artifactSchemas.asset.parse(record.content);
        return content.path === relative(this.root, file) && content.sha256 === sha256File(file);
      });
      if (previousOutput && previousReport && this.store.isCurrent(previousOutput) && this.store.isCurrent(previousReport)
        && canonicalJson(artifactSchemas["lesson-output"].parse(previousOutput.content).composition) === canonicalJson(composition.ref)
        && unchanged) {
        return { summary: "Reused the exact previously verified unchanged fixture output and its approvals; no new content version was created.", references: [toRef(previousOutput), toRef(previousReport)] };
      }
      const media = this.asset("fixture:media:master", master, "video/mp4", [composition.ref], context, "Actual Remotion/FFmpeg clean engineering-fixture render; no cloned presenter and no burned-in captions.");
      const captionedAsset = this.asset("fixture:media:captioned", captioned, "video/mp4", [composition.ref], context, "Actual FFmpeg captioned variant using measured final audio cues.");
      const fullAudio = this.save({
        id: "fixture:final-audio", kind: "audio",
        content: { sceneId: "full-lesson", asset: media, durationMs, measured: true, transcript: transcripts.join("\n\n"), fixture: true },
      }, context);
      const timing = this.save({
        id: "fixture:final-timing", kind: "timing", content: { sceneId: "full-lesson", audio: fullAudio, segments: allCues },
      }, context);
      const srtAsset = this.asset("fixture:media:srt", srt, "text/plain", [fullAudio, timing], context, "SRT captions from actual final synthetic-speech boundaries.");
      const vttAsset = this.asset("fixture:media:vtt", vtt, "text/vtt", [fullAudio, timing], context, "VTT captions from actual final synthetic-speech boundaries.");
      const transcriptAsset = this.asset("fixture:media:transcript", transcript, "text/plain", [fullAudio], context, "Final spoken-word transcript from actual local speech events; not original-script timing estimates or owner ASR.");
      const captions = this.save({
        id: "fixture:final-captions", kind: "captions",
        content: { sceneId: "full-lesson", audio: fullAudio, timing, asset: vttAsset }, dependencies: [srtAsset],
      }, context);
      const check: MediaCheck = mediaCheckSchema.parse({
        playable: true, width: video.width, height: video.height, durationMs, expectedDurationMs,
        audioStreams, videoStreams: probe.streams.filter((stream) => stream.codec_type === "video").length,
        ...loudness, subtitleCueCount: allCues.length, renderMs: Date.now() - startedAt, silenceOver2sCount,
        mediaPath: relative(this.root, master), captionedPath: relative(this.root, captioned),
        transcriptPath: relative(this.root, transcript), srtPath: relative(this.root, srt), vttPath: relative(this.root, vtt),
        nonCloned: true, speechEngine: `Windows System.Speech / ${[...voices].join(", ")}`, remotionVersion: "4.0.539", ffmpegVersion: await this.tools.version(),
      });
      const report = this.save({
        id: "fixture:media-checks", kind: "workflow-report",
        content: { summary: "Actual fixture media passed decoding, dimensions, duration, speech/caption bounds, loudness, peak and silence checks. Human review remains required.",
          references: [media, captionedAsset, captions, transcriptAsset], data: { mediaCheck: jsonSchema.parse(check) } },
      }, context);
      const presenter = this.current("fixture:presenter", "presenter-sample");
      const output = this.save({
        id: "fixture:output", kind: "lesson-output",
        content: {
          videoId: plan.videoId, lesson: plan.lesson, composition: composition.ref, media,
          captions: [captions], presenterMode: "fixture", presenterSample: presenter.ref, verifiedPlayable: true,
        }, dependencies: [report],
      }, context);
      return { summary: "Rendered and verified actual local, non-cloned fixture media. Final human fixture-review is still required.", references: [output, report] };
    } finally {
      if (existsSync(temporary)) rmSync(temporary);
      if (existsSync(captionedTemporary)) rmSync(captionedTemporary);
    }
  }
}

export function createFixtureAdapters(store: StudioStore, workspaceRoot: string, registry: SkillRegistry): readonly FixtureStageAdapter[] {
  const pipeline = new FixturePipeline(store, workspaceRoot, registry);
  const operations = [
    ["studio.fixture-narration", (context: StageAdapterContext) => pipeline.narration(context)],
    ["studio.fixture-alignment", (context: StageAdapterContext) => pipeline.alignment(context)],
    ["studio.fixture-composition", (context: StageAdapterContext) => pipeline.composition(context)],
    ["studio.fixture-render", (context: StageAdapterContext) => pipeline.render(context)],
  ] as const;
  return operations.map(([id, execute]) => ({
    id, version: "1.0.0", inputSchemaId: "studio.stage-input@1", outputSchemaId: "studio.stage-output@1",
    execute: (_input, context) => execute(context),
  }));
}

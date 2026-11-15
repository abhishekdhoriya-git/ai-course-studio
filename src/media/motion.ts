import { Easing, interpolate } from "remotion";
import type { RenderScene } from "./contracts.js";

export interface SpeechAnchor {
  phrase: string;
  text: string;
  startMs: number;
  tokenIndex: number;
  endTokenIndex: number;
  source: "word" | "caption";
}

export interface MotionBeat {
  frame: number;
  source: "word" | "caption" | "fallback";
  anchor?: SpeechAnchor;
}

interface HeadingPlan { kicker: MotionBeat; title: MotionBeat; subtitle: MotionBeat }
interface HeadingState { kicker: number; title: number; subtitle: number }
interface MotionPlanBase {
  fps: number;
  durationFrames: number;
  revealFrames: number;
  exitFrames: number;
  holdFrames: number;
  latestBeatFrame: number;
  heading: HeadingPlan;
}

export interface IntroMotionPlan extends MotionPlanBase {
  layout: "intro";
  presenter: MotionBeat;
  points: MotionBeat[];
}
export interface GatesMotionPlan extends MotionPlanBase {
  layout: "gates";
  cards: MotionBeat[];
  links: MotionBeat[];
  version: MotionBeat;
  renewal: MotionBeat;
}
export interface RevisionMotionPlan extends MotionPlanBase {
  layout: "revision";
  nodes: MotionBeat[];
  sibling: MotionBeat;
  summary: MotionBeat;
}
export interface SkillsMotionPlan extends MotionPlanBase {
  layout: "skills";
  items: MotionBeat[];
  itemRevealFrames: number;
  fourth: MotionBeat;
  route: MotionBeat;
  direct: MotionBeat;
  exclusions: MotionBeat[];
}
export type SceneMotionPlan = IntroMotionPlan | GatesMotionPlan | RevisionMotionPlan | SkillsMotionPlan;

interface MotionStateBase { heading: HeadingState; opacity: number }
export type SceneMotionState =
  | MotionStateBase & { layout: "intro"; presenter: number; points: number[] }
  | MotionStateBase & {
    layout: "gates"; cards: number[]; links: number[]; focus: number; focusedCard: number; version: number; renewal: number;
  }
  | MotionStateBase & { layout: "revision"; nodes: number[]; sibling: number; summary: number }
  | MotionStateBase & { layout: "skills"; items: number[]; fourth: number; route: number; direct: number; exclusions: number[] };

type SpeechTimeline = Pick<RenderScene, "wordTimings" | "captions">;

function words(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().replace(/['’]/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function findSpeechAnchor(
  scene: SpeechTimeline, phrases: string | readonly string[], after?: SpeechAnchor,
): SpeechAnchor | undefined {
  const source = scene.wordTimings?.length ? "word" : "caption";
  const events = source === "word" ? scene.wordTimings! : scene.captions;
  const tokens = events.flatMap((event, eventIndex) =>
    Number.isFinite(event.startMs) && event.startMs >= 0
      ? words(event.text).map((text) => ({ text, startMs: event.startMs, eventIndex }))
      : []);
  const alternatives = (typeof phrases === "string" ? [phrases] : phrases)
    .map((phrase) => ({ phrase, tokens: words(phrase) })).filter((phrase) => phrase.tokens.length > 0);
  for (let index = (after?.endTokenIndex ?? -1) + 1; index < tokens.length; index += 1) {
    for (const alternative of alternatives) {
      const end = index + alternative.tokens.length - 1;
      if (end >= tokens.length || !alternative.tokens.every((word, offset) => tokens[index + offset]?.text === word)) continue;
      // Old manifests can anchor to a real cue start, never to an invented time inside that cue.
      if (source === "caption" && tokens[index]!.eventIndex !== tokens[end]!.eventIndex) continue;
      const first = tokens[index]!;
      return {
        phrase: alternative.phrase, text: tokens.slice(index, end + 1).map((token) => token.text).join(" "),
        startMs: first.startMs, tokenIndex: index, endTokenIndex: end, source,
      };
    }
  }
  return undefined;
}

function bounded(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

function beat(
  anchor: SpeechAnchor | undefined, fallback: number, base: Pick<MotionPlanBase, "fps" | "latestBeatFrame">,
  earliest = 0, latest = base.latestBeatFrame,
): MotionBeat {
  const upper = Math.max(0, Math.min(latest, base.latestBeatFrame));
  const selected = anchor ? Math.round(anchor.startMs * base.fps / 1000) : Math.round(fallback);
  const frame = Math.round(bounded(selected, Math.min(earliest, upper), upper));
  return {
    frame, source: anchor && frame === selected ? anchor.source : "fallback",
    ...(anchor ? { anchor } : {}),
  };
}

function anchorsInOrder(scene: RenderScene, phrases: readonly (readonly string[])[], after?: SpeechAnchor) {
  let previous = after;
  return phrases.map((alternatives) => {
    const anchor = findSpeechAnchor(scene, alternatives, previous);
    if (anchor) previous = anchor;
    return anchor;
  });
}

function orderedBeats(
  anchors: readonly (SpeechAnchor | undefined)[], base: Pick<MotionPlanBase, "fps" | "latestBeatFrame">,
  start = 0, end = base.latestBeatFrame,
): MotionBeat[] {
  const lower = bounded(start, 0, base.latestBeatFrame);
  const upper = bounded(end, lower, base.latestBeatFrame);
  const stagger = Math.max(1, Math.round(base.fps * 0.5));
  const reserve = Math.min(Math.round(base.fps * 0.12), Math.floor((upper - lower) / Math.max(1, anchors.length - 1)));
  let previousPin = -1;
  const pins = anchors.map((anchor, index) => {
    if (!anchor) return undefined;
    const selected = beat(anchor, 0, base, lower, upper - reserve * (anchors.length - index - 1));
    // Several labels in one legacy cue have no distinct word times. Stagger them as explicit fallbacks.
    if (selected.frame <= previousPin) return undefined;
    previousPin = selected.frame;
    return selected;
  });
  const result: MotionBeat[] = [];
  let index = 0;
  while (index < anchors.length) {
    const pin = pins[index];
    if (pin) { result.push(pin); index += 1; continue; }
    let next = index;
    while (next < anchors.length && !pins[next]) next += 1;
    const count = next - index;
    const previous = result.at(-1)?.frame;
    const ceiling = pins[next]?.frame ?? upper;
    const step = Math.min(stagger, Math.max(0, (ceiling - (previous ?? lower))
      / Math.max(1, count + (previous === undefined ? -1 : 0) + (pins[next] ? 1 : 0))));
    for (let offset = 0; offset < count; offset += 1) {
      const frame = Math.round((previous ?? lower) + step * (offset + (previous === undefined ? 0 : 1)));
      const anchor = anchors[index + offset];
      result.push({ frame, source: "fallback", ...(anchor ? { anchor } : {}) });
    }
    index = next;
  }
  return result;
}

export function createSceneMotionPlan(scene: RenderScene, frameRate: number): SceneMotionPlan {
  const fps = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 24;
  const durationFrames = Number.isFinite(scene.durationFrames) ? Math.max(1, Math.floor(scene.durationFrames)) : 1;
  const lastFrame = durationFrames - 1;
  const holdFrames = Math.min(Math.round(fps * 1.1), Math.floor(lastFrame * 0.25));
  const exitFrames = Math.min(Math.round(fps * 0.25), Math.floor(lastFrame * 0.08));
  const revealFrames = Math.min(Math.max(1, Math.round(fps * 0.45)), Math.floor(lastFrame * 0.2));
  const latestBeatFrame = Math.max(0, lastFrame - holdFrames - exitFrames - revealFrames);
  const timing = { fps, latestBeatFrame };
  const headingPhrases = {
    intro: [["engineering fixture"], ["not a course pilot"]],
    gates: [["review gates"], ["approve the curriculum", "approve"]],
    revision: [["one change"], ["replacing a scene", "replacing"]],
    skills: [["repeated work"], ["becomes a skill"]],
  } as const;
  const [titleAnchor, subtitleAnchor] = anchorsInOrder(scene, headingPhrases[scene.layout]);
  const title = beat(titleAnchor, fps * 0.2, timing, Math.round(fps * 0.16));
  const subtitle = beat(subtitleAnchor, title.frame + fps * 0.35, timing, title.frame + Math.round(fps * 0.16));
  const heading = { kicker: beat(undefined, 0, timing), title, subtitle };
  const base = { ...timing, durationFrames, holdFrames, exitFrames, revealFrames, heading };
  const smallGap = Math.max(1, Math.round(fps * 0.16));

  if (scene.layout === "intro") {
    const stages = orderedBeats(anchorsInOrder(scene, [
      ["on screen presenter", "presenter"], ["illustrated stand in"], ["local synthetic voice", "synthetic voice"],
      ["neither is a clone", "not a clone", "neither"],
    ]), timing, Math.min(latestBeatFrame, title.frame + smallGap));
    return { ...base, layout: "intro", presenter: stages[0]!, points: stages.slice(1) };
  }
  if (scene.layout === "gates") {
    // Searching after style disambiguates the named Lesson gate from an opening mention of "this lesson".
    const [curriculum, style] = anchorsInOrder(scene, [["curriculum"], ["original style", "style"]]);
    const lessonContext = style ?? curriculum ?? findSpeechAnchor(scene, ["review gates", "approve"]);
    const lesson = lessonContext ? findSpeechAnchor(scene, "lesson", lessonContext) : findSpeechAnchor(scene, "lesson and storyboard");
    const storyboard = findSpeechAnchor(scene, "storyboard", lesson ?? lessonContext);
    const [versionAnchor, renewalAnchor] = anchorsInOrder(scene, [
      ["each approval", "approval belongs"], ["future edit", "later edit", "new review", "renewed"],
    ], storyboard ?? lesson ?? lessonContext);
    const cardEnd = versionAnchor ? Math.round(versionAnchor.startMs * fps / 1000) - smallGap : latestBeatFrame;
    const cards = orderedBeats([curriculum, style, lesson, storyboard], timing, Math.min(latestBeatFrame, subtitle.frame + smallGap), cardEnd);
    const version = beat(versionAnchor, cards[3]!.frame + fps * 0.65, timing, cards[3]!.frame + smallGap);
    const renewal = beat(renewalAnchor, version.frame + fps * 0.9, timing, version.frame + smallGap);
    return { ...base, layout: "gates", cards, links: cards.slice(1), version, renewal };
  }
  if (scene.layout === "revision") {
    const anchors = anchorsInOrder(scene, [
      ["replacing a scene", "changed scene", "replacing"], ["derived audio", "audio"], ["captions"],
      ["final composition", "composition"], ["unaffected scenes", "unaffected", "reuse"],
    ]);
    const nodes = orderedBeats(anchors.slice(0, 4), timing, Math.min(latestBeatFrame, title.frame + smallGap));
    const sibling = beat(undefined, Math.min(nodes[0]!.frame + smallGap, nodes[1]!.frame), timing);
    const summary = beat(anchors[4], nodes[3]!.frame + fps * 0.6, timing, Math.max(sibling.frame, nodes[3]!.frame));
    return { ...base, layout: "revision", nodes, sibling, summary };
  }

  const fourAnchor = findSpeechAnchor(scene, "four");
  const fourth = beat(fourAnchor, fps * 2.4, timing);
  const itemRevealFrames = Math.min(revealFrames, Math.floor(fourth.frame / 4));
  const itemEnd = Math.max(0, fourth.frame - itemRevealFrames - 1);
  const itemStart = Math.min(Math.round(fps * 0.55), Math.max(0, itemEnd - Math.round(fps)));
  const items = orderedBeats([undefined, undefined, undefined], timing, itemStart, itemEnd);
  const routeAnchor = findSpeechAnchor(scene, "work items", fourAnchor);
  const route = beat(routeAnchor, fourth.frame + revealFrames, timing, fourth.frame + revealFrames);
  const threeAnchor = findSpeechAnchor(scene, "three", fourAnchor);
  const direct = beat(threeAnchor, route.frame + fps * 0.6, timing, fourth.frame + smallGap);
  const exclusions = orderedBeats(anchorsInOrder(scene, [
    ["retries", "retry"], ["polling", "poll"], ["frames", "frame"], ["resumed duplicates", "resumed", "resume"],
  ], threeAnchor ?? fourAnchor), timing, Math.min(latestBeatFrame, Math.max(route.frame, direct.frame) + smallGap));
  return { ...base, layout: "skills", items, itemRevealFrames, fourth, route, direct, exclusions };
}

export function revealProgress(frame: number, stage: MotionBeat, revealFrames: number): number {
  if (revealFrames <= 0) return frame >= stage.frame ? 1 : 0;
  return interpolate(frame, [stage.frame, stage.frame + revealFrames], [0, 1], {
    easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
}

export function gateVersionPosition(focus: number, renewal: number): { left: number; top: number } {
  const clamped = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  return {
    left: interpolate(renewal, [0, 0.6, 1], [94 + focus * 290, 1114, 1114], clamped),
    top: interpolate(renewal, [0, 0.6, 1], [442, 442, 500], clamped),
  };
}

export function sceneMotionState(plan: SceneMotionPlan, frame: number): SceneMotionState {
  const progress = (stage: MotionBeat) => revealProgress(frame, stage, plan.revealFrames);
  const common = {
    heading: { kicker: progress(plan.heading.kicker), title: progress(plan.heading.title), subtitle: progress(plan.heading.subtitle) },
    opacity: plan.exitFrames === 0 ? 1 : interpolate(
      frame, [plan.durationFrames - 1 - plan.exitFrames, plan.durationFrames - 1], [1, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    ),
  };
  if (plan.layout === "intro") return { ...common, layout: "intro", presenter: progress(plan.presenter), points: plan.points.map(progress) };
  if (plan.layout === "gates") {
    let focusedCard = -1;
    let focus = 0;
    plan.cards.forEach((card, index) => {
      if (frame >= card.frame) { focusedCard = index; focus = index === 0 ? 0 : index - 1 + progress(card); }
    });
    return {
      ...common, layout: "gates", cards: plan.cards.map(progress), links: plan.links.map(progress),
      focusedCard, focus, version: progress(plan.version), renewal: progress(plan.renewal),
    };
  }
  if (plan.layout === "revision") return {
    ...common, layout: "revision", nodes: plan.nodes.map(progress), sibling: progress(plan.sibling), summary: progress(plan.summary),
  };
  return {
    ...common, layout: "skills", items: plan.items.map((item) => revealProgress(frame, item, plan.itemRevealFrames)),
    fourth: progress(plan.fourth), route: progress(plan.route), direct: progress(plan.direct), exclusions: plan.exclusions.map(progress),
  };
}

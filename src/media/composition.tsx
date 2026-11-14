import { useMemo } from "react";
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { CaptionCue, RenderManifest, RenderScene } from "./contracts.js";

export type StudioFixtureProps = { manifest?: RenderManifest };

export const FIXTURE_DISCLOSURE = "ENGINEERING FIXTURE / NON-CLONED PRESENTER & VOICE";

const palette = {
  background: "#101827",
  panel: "#172339",
  inset: "#0c1422",
  line: "#344660",
  white: "#f4f7fc",
  muted: "#acb9cd",
  teal: "#68e8c5",
  amber: "#f3be72",
};
const bodyFont = "Arial, sans-serif";
const headingFont = '"Trebuchet MS", Arial, sans-serif';
const layouts = new Set<RenderScene["layout"]>(["intro", "gates", "revision", "skills"]);

export function validateRenderManifest(manifest: RenderManifest | undefined): RenderManifest {
  if (!manifest || !Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
    throw new Error("StudioFixture requires a non-empty render manifest. No default lesson is provided.");
  }
  if (manifest.fixture !== true || manifest.disclosure !== FIXTURE_DISCLOSURE) {
    throw new Error("StudioFixture requires the engineering-fixture and non-cloned presenter/voice disclosures.");
  }
  if (typeof manifest.title !== "string" || !manifest.title.trim()) {
    throw new Error("StudioFixture requires a lesson title.");
  }
  if (!Number.isSafeInteger(manifest.width) || manifest.width <= 0
    || !Number.isSafeInteger(manifest.height) || manifest.height <= 0
    || !Number.isFinite(manifest.fps) || manifest.fps <= 0) {
    throw new Error("StudioFixture requires positive dimensions and a finite, positive frame rate.");
  }
  const ids = new Set<string>();
  let total = 0;
  for (const scene of manifest.scenes) {
    if (!scene || typeof scene.id !== "string" || !scene.id.trim() || ids.has(scene.id)) {
      throw new Error("StudioFixture requires distinct, non-empty scene IDs.");
    }
    ids.add(scene.id);
    if (!layouts.has(scene.layout) || !Number.isSafeInteger(scene.durationFrames) || scene.durationFrames <= 0) {
      throw new Error(`Scene ${scene.id} needs a supported layout and a measured, positive frame duration.`);
    }
    if (typeof scene.audioPath !== "string" || !scene.audioPath.trim()
      || /^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(scene.audioPath)
      || scene.audioPath.includes("\\") || scene.audioPath.split("/").includes("..")) {
      throw new Error(`Scene ${scene.id} needs a relative staticFile audio URL, not an absolute path or remote URL.`);
    }
    if (!Array.isArray(scene.captions) || scene.captions.length === 0) {
      throw new Error(`Scene ${scene.id} needs measured caption cues.`);
    }
    const durationMs = scene.durationFrames * 1000 / manifest.fps;
    for (const cue of scene.captions) {
      if (!cue || typeof cue.text !== "string" || !cue.text.trim()
        || !Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs)
        || cue.startMs < 0 || cue.endMs <= cue.startMs || cue.endMs > durationMs + 0.001) {
        throw new Error(`Scene ${scene.id} has a caption outside its measured timeline or an invalid caption cue.`);
      }
    }
    total += scene.durationFrames;
  }
  if (!Number.isSafeInteger(total)) throw new Error("StudioFixture's total frame duration is invalid.");
  return manifest;
}

function activeCues(cues: CaptionCue[], frame: number, fps: number): CaptionCue[] {
  const timeMs = frame * 1000 / fps;
  return cues.filter((cue) => cue.startMs <= timeMs && timeMs < cue.endMs);
}

function fitCaption(text: string): { lines: string[]; fontSize: number } {
  const context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  const words = text.trim().split(/\s+/);
  for (let fontSize = 30; fontSize >= 24; fontSize -= 1) {
    if (context) context.font = `600 ${fontSize}px Arial`;
    const measure = (line: string): number => context?.measureText(line).width ?? line.length * fontSize * 0.58;
    if (measure(text) <= 1120) return { lines: [text], fontSize };
    let best: { lines: string[]; difference: number } | undefined;
    for (let split = 1; split < words.length; split += 1) {
      const first = words.slice(0, split).join(" ");
      const second = words.slice(split).join(" ");
      const firstWidth = measure(first);
      const secondWidth = measure(second);
      const difference = Math.abs(firstWidth - secondWidth);
      if (Math.max(firstWidth, secondWidth) <= 1120 && (!best || difference < best.difference)) {
        best = { lines: [first, second], difference };
      }
    }
    if (best) return { lines: best.lines, fontSize };
  }
  throw new Error("An active caption does not fit the two-line safe zone. Split cues at measured speech boundaries.");
}

function CaptionBand({ text }: { text: string }) {
  const fitted = useMemo(() => text ? fitCaption(text) : undefined, [text]);
  if (!fitted) return null;
  return (
    <div aria-label="Narration captions" style={{
      position: "absolute", left: 80, right: 80, top: 614, height: 94, zIndex: 5,
      display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center",
      fontFamily: bodyFont, fontWeight: 600, fontSize: fitted.fontSize, lineHeight: "38px",
      color: palette.white, textAlign: "center",
    }}>
      {fitted.lines.map((line, index) => <div key={index} style={{ whiteSpace: "pre" }}>{line}</div>)}
    </div>
  );
}

function Badge({ children, tone = "teal", style }: {
  children: ReactNode; tone?: "teal" | "amber" | "muted"; style?: CSSProperties;
}) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 8, padding: "7px 11px",
      border: `1px solid ${palette[tone]}`, borderRadius: 7, color: palette[tone],
      fontSize: 14, fontWeight: 700, lineHeight: "18px", letterSpacing: 0.8, ...style,
    }}>{children}</span>
  );
}

function Panel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ background: palette.panel, border: `1px solid ${palette.line}`, borderRadius: 18, ...style }}>{children}</div>;
}

function SceneHeading({ kicker, title, subtitle }: { kicker: string; title: string; subtitle: string }) {
  return (
    <div style={{ position: "absolute", left: 72, top: 97, width: 1136 }}>
      <div style={{ color: palette.teal, fontSize: 15, fontWeight: 700, letterSpacing: 2, marginBottom: 10 }}>{kicker}</div>
      <h1 style={{ fontFamily: headingFont, fontSize: 44, lineHeight: 1.1, letterSpacing: -1.2, margin: 0 }}>{title}</h1>
      <p style={{ fontSize: 23, lineHeight: 1.3, color: palette.muted, margin: "13px 0 0" }}>{subtitle}</p>
    </div>
  );
}

function StandIn() {
  return (
    <svg width="330" height="274" viewBox="0 0 330 274" role="img" aria-label="Original geometric illustrated stand-in, not a real person's likeness">
      <path d="M53 41H32V228H53 M277 41H298V228H277" fill="none" stroke={palette.line} strokeWidth="2" />
      <circle cx="165" cy="86" r="54" fill="#9aafc9" />
      <path d="M123 53A54 54 0 0 1 208 57" fill="none" stroke="#bac8da" strokeWidth="8" strokeLinecap="round" />
      <rect x="140" y="136" width="50" height="35" rx="10" fill="#9aafc9" />
      <path d="M78 241V211C78 173 114 157 165 157S252 173 252 211V241Z" fill={palette.teal} />
      <path d="M122 163L165 192L208 163" fill="none" stroke="#287465" strokeWidth="3" />
      <rect x="138" y="77" width="17" height="9" rx="4.5" fill={palette.background} />
      <rect x="175" y="77" width="17" height="9" rx="4.5" fill={palette.background} />
      <rect x="145" y="206" width="40" height="19" rx="5" fill={palette.background} />
      <path d="M156 215H174" stroke={palette.teal} strokeWidth="2" />
      <path d="M65 244H265" stroke={palette.line} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IntroVisual({ title }: { title: string }) {
  const limitations = [
    ["01", "Illustrated stand-in", "No owner likeness or recordings"],
    ["02", "Local synthetic voice", "Not an owner voice clone"],
    ["03", "Fixture, not a pilot", "Subject, provider & budget stay user decisions"],
  ] as const;
  return (
    <>
      <div style={{ position: "absolute", left: 72, top: 113, width: 720 }}>
        <div style={{ color: palette.teal, fontSize: 16, fontWeight: 700, letterSpacing: 2 }}>A LOCAL LESSON ABOUT STUDIO CONTRACTS</div>
        <h1 style={{ fontFamily: headingFont, fontSize: 54, lineHeight: 1.08, letterSpacing: -1.6, margin: "20px 0 16px", maxWidth: 690 }}>
          {title === "From brief to reviewed lesson" ? <>From brief<br />to reviewed lesson.</> : title}
        </h1>
        <p style={{ fontSize: 25, lineHeight: 1.35, color: palette.muted, margin: 0 }}>Exact versions. Clear review gates.<br />Selective revision. Reusable work.</p>
      </div>
      <div style={{ position: "absolute", left: 72, top: 357, width: 720, display: "flex", flexDirection: "column", gap: 14 }}>
        {limitations.map(([number, label, detail]) => (
          <div key={number} style={{ display: "flex", gap: 16, alignItems: "center", minHeight: 58 }}>
            <div style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 10, background: palette.panel, border: `1px solid ${palette.line}`, display: "grid", placeItems: "center", color: palette.teal, fontSize: 17 }}>{number}</div>
            <div>
              <div style={{ fontSize: 23, fontWeight: 700, lineHeight: "28px" }}>{label}</div>
              <div style={{ fontSize: 19, color: palette.muted, lineHeight: "25px" }}>{detail}</div>
            </div>
          </div>
        ))}
      </div>
      <Panel style={{ position: "absolute", left: 850, top: 111, width: 358, height: 449, textAlign: "center" }}>
        <Badge style={{ marginTop: 23 }}>NON-CLONED PLACEHOLDER</Badge>
        <div style={{ marginTop: 12 }}><StandIn /></div>
        <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: 1, marginTop: 5 }}>ILLUSTRATED STAND-IN</div>
        <div style={{ color: palette.muted, fontSize: 17, marginTop: 10 }}>No likeness. No lip-sync claim.</div>
        <div style={{ color: palette.amber, fontSize: 16, marginTop: 15 }}>No identity uploads · no publishing</div>
      </Panel>
    </>
  );
}

function GateIcon({ kind }: { kind: "curriculum" | "style" | "lesson" | "storyboard" }) {
  const paths = {
    curriculum: <><path d="M4 5H14C17 5 18 7 18 9V29C18 26 16 25 13 25H4Z M32 5H22C19 5 18 7 18 9V29C18 26 20 25 23 25H32Z" /><path d="M8 11H12 M24 11H28 M8 16H12 M24 16H28" /></>,
    style: <><rect x="4" y="4" width="28" height="28" rx="6" /><path d="M11 25L14 17L24 8L28 12L19 22Z M14 17L19 22" /></>,
    lesson: <><rect x="4" y="6" width="28" height="22" rx="4" /><path d="M14 11L24 17L14 23Z M11 32H25" /></>,
    storyboard: <><rect x="4" y="5" width="28" height="26" rx="4" /><path d="M18 5V31 M4 18H32 M9 10H13 M23 23H27" /></>,
  };
  return <svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke={palette.teal} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

function GatesVisual({ narration }: { narration: string }) {
  const cards = [
    { label: "Curriculum", kind: "curriculum", keywords: ["curriculum"] },
    { label: "Original style", kind: "style", keywords: ["style"] },
    { label: "Lesson", kind: "lesson", keywords: ["lesson"] },
    { label: "Storyboard", kind: "storyboard", keywords: ["storyboard"] },
  ] as const;
  return (
    <>
      <SceneHeading kicker="EXACT-VERSION APPROVALS" title="Every gate names an exact version." subtitle="Review the curriculum, original style, lesson and storyboard before rendering." />
      <div style={{ position: "absolute", left: 72, top: 235, width: 1136, display: "flex", gap: 24 }}>
        {cards.map((card, index) => {
          const focused = card.keywords.some((word) => narration.toLowerCase().includes(word));
          return (
            <Panel key={card.kind} style={{ width: 266, height: 198, boxSizing: "border-box", padding: 21, position: "relative", borderColor: focused ? palette.teal : palette.line }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <GateIcon kind={card.kind} />
                <span style={{ fontSize: 15, color: palette.muted }}>GATE 0{index + 1}</span>
              </div>
              <div style={{ fontFamily: headingFont, fontSize: 26, fontWeight: 700, marginTop: 16 }}>{card.label}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 13, marginTop: 15 }}>
                <Badge style={{ fontSize: 20, lineHeight: "24px" }}>v1</Badge>
                <span style={{ color: palette.muted, fontSize: 17 }}>Exact version</span>
              </div>
              <div style={{ color: palette.muted, fontSize: 13, letterSpacing: 1.1, marginTop: 11 }}>REVIEW IS VERSION-BOUND</div>
              {index < cards.length - 1 ? (
                <svg width="22" height="18" viewBox="0 0 22 18" style={{ position: "absolute", right: -24, top: 85 }} aria-hidden="true">
                  <path d="M1 9H17M12 4L18 9L12 14" fill="none" stroke={palette.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : null}
            </Panel>
          );
        })}
      </div>
      <Panel style={{ position: "absolute", left: 72, top: 461, width: 1136, height: 99, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 25px", boxSizing: "border-box" }}>
        <div>
          <div style={{ fontSize: 13, letterSpacing: 1.4, color: palette.amber, marginBottom: 9 }}>ILLUSTRATED VERSION EXAMPLE — NOT LIVE APPROVAL STATUS</div>
          <div style={{ fontSize: 25, fontWeight: 700 }}>An approval of v1 does not cover a later edit.</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 15 }}>
          <Badge style={{ fontSize: 24, padding: "12px 16px" }}>v1</Badge>
          <span style={{ fontSize: 25, color: palette.muted }}>→</span>
          <div style={{ textAlign: "center" }}>
            <Badge tone="amber" style={{ fontSize: 24, padding: "9px 16px" }}>v2</Badge>
            <div style={{ fontSize: 13, color: palette.amber, marginTop: 5 }}>NEW REVIEW</div>
          </div>
        </div>
      </Panel>
    </>
  );
}

function DependencyNode({ left, top, width, title, status, detail, tone }: {
  left: number; top: number; width: number; title: string; status: string; detail: string; tone: "teal" | "amber";
}) {
  return (
    <Panel style={{ position: "absolute", left, top, width, height: 100, boxSizing: "border-box", padding: "13px 16px", borderColor: palette[tone] }}>
      <div style={{ color: palette[tone], fontSize: 13, fontWeight: 700, letterSpacing: 1 }}>{status}</div>
      <div style={{ fontFamily: headingFont, fontSize: 25, fontWeight: 700, marginTop: 7 }}>{title}</div>
      <div style={{ color: palette.muted, fontSize: 16, marginTop: 5 }}>{detail}</div>
    </Panel>
  );
}

function RevisionVisual() {
  return (
    <>
      <SceneHeading kicker="SELECTIVE INVALIDATION · EXAMPLE DEPENDENCIES" title="Change one scene. Keep its sibling." subtitle="Only the changed branch and its shared final output become stale." />
      <div style={{ position: "absolute", left: 72, top: 231, width: 1136, height: 252 }}>
        <svg width="1136" height="252" viewBox="0 0 1136 252" style={{ position: "absolute", inset: 0 }} role="img" aria-label="Changed scene A invalidates audio A, captions A and the shared composition. Unchanged scene B, audio B and captions B remain reusable.">
          <defs>
            <marker id="fixture-stale-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0L7 4L0 8" fill="none" stroke={palette.amber} strokeWidth="1.5" /></marker>
            <marker id="fixture-reuse-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0L7 4L0 8" fill="none" stroke={palette.teal} strokeWidth="1.5" /></marker>
          </defs>
          <g fill="none" strokeWidth="2.5" strokeLinejoin="round">
            <path d="M208 50H274 M466 50H526 M720 50H784V94H839" stroke={palette.amber} markerEnd="url(#fixture-stale-arrow)" />
            <path d="M208 200H274 M466 200H526 M720 200H784V156H839" stroke={palette.teal} markerEnd="url(#fixture-reuse-arrow)" />
          </g>
        </svg>
        <DependencyNode left={0} top={0} width={208} title="Scene A" status="CHANGED" detail="Example: v1 → v2" tone="amber" />
        <DependencyNode left={282} top={0} width={184} title="Audio A" status="INVALIDATED" detail="Derived from A" tone="amber" />
        <DependencyNode left={534} top={0} width={186} title="Captions A" status="INVALIDATED" detail="Timed to audio A" tone="amber" />
        <DependencyNode left={0} top={150} width={208} title="Scene B" status="UNCHANGED" detail="Example: v1 retained" tone="teal" />
        <DependencyNode left={282} top={150} width={184} title="Audio B" status="REUSABLE" detail="Keep existing audio" tone="teal" />
        <DependencyNode left={534} top={150} width={186} title="Captions B" status="REUSABLE" detail="Keep existing cues" tone="teal" />
        <Panel style={{ position: "absolute", left: 848, top: 47, width: 288, height: 159, boxSizing: "border-box", padding: "17px 20px", borderColor: palette.amber }}>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1, color: palette.amber }}>SHARED OUTPUT · STALE</div>
          <div style={{ fontFamily: headingFont, fontSize: 30, fontWeight: 700, marginTop: 11 }}>Composition</div>
          <div style={{ fontSize: 18, lineHeight: "25px", color: palette.muted, marginTop: 11 }}>Rebuild the changed branch.<br />Request a new review.</div>
        </Panel>
      </div>
      <Panel style={{ position: "absolute", left: 72, top: 522, width: 1136, height: 49, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 22px", boxSizing: "border-box" }}>
        <span style={{ fontSize: 21, color: palette.teal }}>Unchanged siblings stay reusable.</span>
        <span style={{ fontSize: 18, color: palette.muted }}>Amber: invalidated &nbsp; / &nbsp; Teal: retained</span>
      </Panel>
    </>
  );
}

function WorkItem({ label, fourth }: { label: string; fourth: boolean }) {
  return (
    <div style={{ height: 84, flex: 1, border: `1px solid ${fourth ? palette.amber : palette.line}`, borderRadius: 10, background: palette.inset, textAlign: "center", boxSizing: "border-box", paddingTop: 13 }}>
      <div style={{ color: palette.muted, fontSize: 13, letterSpacing: 1 }}>REVIEW</div>
      <div style={{ fontFamily: headingFont, fontSize: 33, fontWeight: 700, color: fourth ? palette.amber : palette.white, marginTop: 5 }}>{label}</div>
    </div>
  );
}

function WorkItemsPanel({ count, left }: { count: 3 | 4; left: number }) {
  const four = count === 4;
  return (
    <Panel style={{ position: "absolute", left, top: 226, width: 544, height: 246, boxSizing: "border-box", borderColor: four ? palette.teal : palette.line }}>
      <div style={{ position: "absolute", left: 25, top: 18 }}>
        <span style={{ fontFamily: headingFont, fontSize: 28, fontWeight: 700, color: four ? palette.teal : palette.white }}>{four ? "FOUR" : "THREE"}</span>
        <span style={{ fontSize: 19, color: palette.muted, marginLeft: 12 }}>distinct work items</span>
      </div>
      <div style={{ position: "absolute", top: 74, left: four ? 30 : 58, right: four ? 30 : 58, display: "flex", gap: four ? 12 : 16 }}>
        {["A", "B", "C", "D"].slice(0, count).map((label, index) => <WorkItem key={label} label={label} fourth={four && index === 3} />)}
      </div>
      {four ? (
        <svg width="544" height="190" viewBox="0 0 544 190" style={{ position: "absolute", top: 0, left: 0 }} aria-hidden="true">
          <path d="M86 160V176H458V160 M210 160V176 M334 160V176 M272 176V188" fill="none" stroke={palette.teal} strokeWidth="2" strokeLinejoin="round" />
        </svg>
      ) : null}
      <div style={{ position: "absolute", top: 193, left: 24, right: 24, display: "flex", justifyContent: "center" }}>
        <Badge tone={four ? "teal" : "muted"} style={{ fontSize: 19, letterSpacing: 0, padding: "8px 16px" }}>{four ? "One pinned local skill" : "Direct work · no extraction"}</Badge>
      </div>
    </Panel>
  );
}

function SkillsVisual() {
  return (
    <>
      <SceneHeading kicker="PER-VIDEO SKILL BOUNDARY" title="Three is direct. Four routes to a skill." subtitle="Count distinct work items inside one video — not repeated execution events." />
      <WorkItemsPanel count={3} left={72} />
      <WorkItemsPanel count={4} left={664} />
      <div style={{ position: "absolute", left: 72, top: 501, width: 1136, height: 81, boxSizing: "border-box", border: `1px dashed ${palette.line}`, borderRadius: 13, background: palette.inset, padding: "0 23px", display: "flex", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ flexShrink: 0 }}>
          <div style={{ color: palette.amber, fontSize: 13, fontWeight: 700, letterSpacing: 1.2 }}>NOT WORK ITEMS</div>
          <div style={{ fontSize: 21, fontWeight: 700, marginTop: 6 }}>Outside the count</div>
        </div>
        {["Retries", "Polling", "Frames", "Resumed duplicates"].map((event) => (
          <div key={event} style={{ display: "flex", gap: 9, alignItems: "center", color: palette.muted, fontSize: 20, whiteSpace: "nowrap" }}>
            <span style={{ color: palette.amber, fontSize: 23 }}>×</span>{event}
          </div>
        ))}
      </div>
    </>
  );
}

function SceneContent({ scene, title, burnInCaptions }: { scene: RenderScene; title: string; burnInCaptions: boolean }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const text = activeCues(scene.captions, frame, fps).map((cue) => cue.text.trim()).join(" ").replace(/\s+/g, " ");
  const entranceFrames = Math.max(1, Math.min(Math.round(fps * 0.2), scene.durationFrames - 1));
  const shift = interpolate(frame, [0, entranceFrames], [6, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <Audio src={staticFile(scene.audioPath)} />
      <AbsoluteFill style={{ transform: `translateY(${shift}px)` }}>
        {scene.layout === "intro" ? <IntroVisual title={title} /> : null}
        {scene.layout === "gates" ? <GatesVisual narration={text} /> : null}
        {scene.layout === "revision" ? <RevisionVisual /> : null}
        {scene.layout === "skills" ? <SkillsVisual /> : null}
      </AbsoluteFill>
      {burnInCaptions ? <CaptionBand text={text} /> : null}
    </AbsoluteFill>
  );
}

export function StudioFixture({ manifest: providedManifest }: StudioFixtureProps) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const manifest = useMemo(() => validateRenderManifest(providedManifest), [providedManifest]);
  const timeline = useMemo(() => {
    let from = 0;
    return manifest.scenes.map((scene) => {
      const item = { scene, from };
      from += scene.durationFrames;
      return item;
    });
  }, [manifest]);
  const currentIndex = timeline.findIndex(({ scene, from }) => from <= frame && frame < from + scene.durationFrames);
  const scale = Math.min(width / 1280, height / 720);
  return (
    <AbsoluteFill style={{ backgroundColor: palette.background }}>
      <div style={{
        position: "absolute", width: 1280, height: 720,
        left: (width - 1280 * scale) / 2, top: (height - 720 * scale) / 2,
        transform: `scale(${scale})`, transformOrigin: "top left",
        fontFamily: bodyFont, color: palette.white, backgroundColor: palette.background,
      }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 604, height: 116, background: palette.inset, borderTop: `1px solid ${palette.line}` }} />
        {timeline.map(({ scene, from }) => (
          <Sequence key={scene.id} name={scene.title} from={from} durationInFrames={scene.durationFrames}>
            <SceneContent scene={scene} title={manifest.title} burnInCaptions={manifest.burnInCaptions === true} />
          </Sequence>
        ))}
        <header style={{ position: "absolute", top: 0, left: 0, right: 0, height: 65, zIndex: 10, background: palette.background, borderBottom: `1px solid ${palette.line}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 38px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span style={{ width: 9, height: 9, background: palette.teal, borderRadius: 2 }} />
            <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: 0.5, color: palette.teal }}>{FIXTURE_DISCLOSURE}</span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {timeline.map(({ scene }, index) => <span key={scene.id} style={{ width: 23, height: 4, borderRadius: 2, background: index === currentIndex ? palette.teal : palette.line }} />)}
            <span style={{ marginLeft: 9, color: palette.muted, fontSize: 16 }}>{String(currentIndex + 1).padStart(2, "0")} / {String(timeline.length).padStart(2, "0")}</span>
          </div>
        </header>
      </div>
    </AbsoluteFill>
  );
}

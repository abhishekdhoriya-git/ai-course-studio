import type { ArtifactKind, ArtifactRecord, ArtifactRef, ApprovalGate } from "../domain/schemas.js";
import type { ReviewState, PublicJob } from "../review-contract.js";

type Tab = "review" | "brief" | "workflows" | "skills" | "quality";
const tabs: Record<Tab, { label: string; title: string; description: string }> = {
  review: { label: "Review desk", title: "Make every version reviewable.", description: "A local production pipeline with clear gates, durable work and no hidden approvals." },
  brief: { label: "Course brief", title: "A good lesson starts with a clear brief.", description: "Your audience and objectives guide the course. The studio never picks the pilot for you." },
  workflows: { label: "Workflows", title: "Know what ran. Know what stopped.", description: "Pinned versions, durable attempts and explicit pause reasons. Resume approved work without starting over." },
  skills: { label: "Skill registry", title: "Repeat the work. Not the guesswork.", description: "Four distinct work items inside one video trigger skill extraction. Retries and frames stay outside the count." },
  quality: { label: "Quality loop", title: "A real bar. An honest verdict.", description: "Named references, fresh-context critiques and auditable rounds. Missing evidence is a blocker, never a win." },
};
let state: ReviewState | undefined;
let dirty = false;
let refreshBusy = false;
let signature = "";
let editing = false;

function required<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing review interface element: ${id}`);
  return node as T;
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(label: string, action: () => void | Promise<void>, className = "secondary"): HTMLButtonElement {
  const node = element("button", `button ${className}`, label);
  node.type = "button";
  node.addEventListener("click", () => { void perform(action, node); });
  return node;
}
function tag(label: string, status = label): HTMLElement {
  return element("span", `tag ${status.replace(/[^a-z-]/g, "")}`, label.toUpperCase());
}
function refOf(record: ArtifactRef): ArtifactRef { return { id: record.id, version: record.version, hash: record.hash }; }
function currentRecords(): ArtifactRecord[] {
  if (!state) return [];
  return state.artifacts.filter((record) => record.invalidatedAt === null
    && !state!.artifacts.some((other) => other.id === record.id && other.version > record.version));
}
function currentTab(): Tab {
  const value = new URL(location.href).searchParams.get("tab");
  return value && value in tabs ? value as Tab : "review";
}
function mediaUrl(ref: ArtifactRef): string {
  return `/media?id=${encodeURIComponent(ref.id)}&version=${ref.version}`;
}
function nameOf(record: ArtifactRecord): string {
  const content = record.content;
  return "title" in content && typeof content.title === "string" ? content.title : record.id;
}
function notify(message: string, error = false): void {
  const notice = required("notice");
  notice.className = `notice${error ? " error" : ""}`;
  notice.textContent = message;
}
async function perform(action: () => void | Promise<void>, control?: HTMLButtonElement): Promise<void> {
  if (control) control.disabled = true;
  try { await action(); }
  catch (error) { notify(error instanceof Error ? error.message : "The local action failed.", true); }
  finally { if (control?.isConnected) control.disabled = false; }
}
async function post(path: string, input: unknown): Promise<unknown> {
  if (!state) throw new Error("The review session has not loaded. Reload before taking an action.");
  const response = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Studio-Token": state.token }, body: JSON.stringify(input),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    throw new Error(result && typeof result === "object" && "error" in result && typeof result.error === "string"
      ? result.error : `The local action failed (${response.status}).`);
  }
  return result;
}
async function confirmChange(title: string, message: string): Promise<boolean> {
  const dialog = required<HTMLDialogElement>("confirmation");
  required("confirmation-title").textContent = title;
  required("confirmation-message").textContent = message;
  dialog.returnValue = "cancel";
  return new Promise((accept) => {
    dialog.addEventListener("close", () => accept(dialog.returnValue === "confirm"), { once: true });
    dialog.showModal();
  });
}
async function navigate(tab: Tab, artifact?: ArtifactRef): Promise<void> {
  if (dirty && !await confirmChange("Discard unsaved edits?", "Your changes have not been saved. Keep this form open or discard the unsaved draft.")) return;
  dirty = false; editing = false;
  const url = new URL(location.href);
  url.searchParams.set("tab", tab);
  if (artifact) { url.searchParams.set("artifact", artifact.id); url.searchParams.set("version", String(artifact.version)); }
  history.pushState(null, "", url);
  render();
}

async function refresh(force = false): Promise<void> {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    const value: unknown = await response.json();
    if (!response.ok || !value || typeof value !== "object" || !("token" in value)
      || typeof value.token !== "string" || !("artifacts" in value) || !Array.isArray(value.artifacts)) {
      throw new Error("The local review state could not be loaded. Check the server and reload.");
    }
    state = value as ReviewState;
    const next = JSON.stringify(state);
    const focusedControl = document.activeElement instanceof HTMLInputElement
      || document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLSelectElement;
    if (force || (next !== signature && !dirty && !editing && !focusedControl)) { signature = next; render(); }
  } catch (error) { notify(error instanceof Error ? error.message : "Review refresh failed.", true); }
  finally { refreshBusy = false; }
}

function render(): void {
  if (!state) return;
  const tab = currentTab();
  const copy = tabs[tab];
  required("page-name").textContent = copy.label;
  required("page-title").textContent = copy.title;
  required("page-description").textContent = copy.description;
  document.title = `${copy.label} | AI Course Studio`;
  for (const key of Object.keys(tabs) as Tab[]) {
    required(`${key}-panel`).hidden = tab !== key;
    const link = document.querySelector<HTMLAnchorElement>(`[data-tab="${key}"]`);
    if (key === tab) link?.setAttribute("aria-current", "page"); else link?.removeAttribute("aria-current");
  }
  const fixtureButton = required<HTMLButtonElement>("load-fixture");
  fixtureButton.textContent = state.fixture ? "Engineering fixture loaded" : "Load engineering fixture";
  fixtureButton.disabled = state.fixture !== null;
  if (tab === "review") renderReview();
  if (tab === "workflows") renderWorkflows();
  if (tab === "skills") renderSkills();
  if (tab === "quality") renderQuality();
}

function renderReview(): void {
  if (!state) return;
  const panel = required("review-panel");
  const stats = element("div", "stats");
  const approvals = state.decisions.filter((decision) => decision.decision === "approved" && decision.invalidatedAt === null
    && currentRecords().some((record) => record.id === decision.artifactId && record.version === decision.version)).length;
  for (const [label, count] of [["Artifact versions", state.totals.artifacts], ["Durable jobs", state.totals.jobs], ["Current approvals", approvals]] as const) {
    const stat = element("div", "stat");
    stat.append(element("span", "stat-label", label), element("strong", "stat-value", new Intl.NumberFormat().format(count)));
    stats.append(stat);
  }
  panel.replaceChildren(stats);
  if (!state.fixture && currentRecords().length === 0) {
    const empty = element("div", "empty-card");
    empty.append(element("p", "eyebrow", "YOUR LOCAL STUDIO IS READY"), element("h2", "", "Start with a brief, or inspect the fixture."),
      element("p", "", "The engineering fixture demonstrates the workflow with original graphics and a non-cloned presenter. It is not your course pilot."),
      button("Create a course brief", () => navigate("brief"), "primary"));
    panel.append(empty); return;
  }
  if (state.fixture) {
    const grid = element("div", "review-grid");
    const preview = element("div", "card preview-card");
    const header = element("div", "preview-heading");
    header.append(element("h2", "", state.fixture.title), tag("Engineering fixture", "fixture"));
    const media = element("div", "preview-media");
    const output = state.fixture.output ? state.artifacts.find((record) => record.id === state!.fixture!.output!.id
      && record.version === state!.fixture!.output!.version) : undefined;
    if (output && "media" in output.content) {
      const video = element("video");
      video.controls = true; video.preload = "metadata"; video.width = 1280; video.height = 720;
      video.setAttribute("aria-label", "Engineering fixture with a non-cloned placeholder presenter and synthetic voice");
      video.src = mediaUrl(output.content.media);
      if (state.fixture.poster) video.poster = mediaUrl(state.fixture.poster);
      for (const captionRef of "captions" in output.content ? output.content.captions : []) {
        const caption = state.artifacts.find((record) => record.id === captionRef.id && record.version === captionRef.version);
        if (caption && "asset" in caption.content) {
          const captionAsset = caption.content.asset;
          const asset = state.artifacts.find((record) => record.id === captionAsset.id && record.version === captionAsset.version);
          if (asset?.kind === "asset" && "mediaType" in asset.content && asset.content.mediaType === "text/vtt") {
            const track = element("track"); track.kind = "captions"; track.srclang = "en"; track.label = "English fixture captions";
            track.default = true; track.src = mediaUrl(caption.content.asset); video.append(track); break;
          }
        }
      }
      media.append(video);
    } else if (state.fixture.poster) {
      const poster = element("img"); poster.src = mediaUrl(state.fixture.poster); poster.width = 1280; poster.height = 720;
      poster.alt = "Original style sample for the engineering fixture. A vector stand-in is labeled non-cloned.";
      media.append(poster);
    }
    const footer = element("div", "preview-footer");
    footer.append(element("p", "", output ? "Actual local media. Owner lesson review remains a separate decision." : "Original still sample. Review the exact inputs before rendering."));
    const renderButton = button(output ? "Render current fixture again" : "Render approved fixture", async () => {
      await post("/api/fixture/render", {}); notify("The local fixture job is queued. Rendering and final review remain separate stages."); await refresh(true);
    }, "primary small");
    renderButton.disabled = !state.fixture.readyToRender;
    footer.append(renderButton);
    preview.append(header, media, footer);
    const gates = element("div", "card");
    const heading = element("div", "section-heading");
    heading.append(element("h2", "", "Before the first render"), element("span", "count", `${state.fixture.gates.filter((gate) => gate.approved).length} / ${state.fixture.gates.length} reviewed`));
    const list = element("div", "gate-list");
    state.fixture.gates.forEach((gate, index) => {
      const artifact = state!.artifacts.find((record) => record.id === gate.ref.id && record.version === gate.ref.version);
      const row = element("div", "gate");
      const label = element("div");
      label.append(element("p", "gate-title", artifact?.kind.replace(/-/g, " ") ?? gate.ref.id),
        element("span", "gate-sub", `v${gate.ref.version} / ${gate.approved ? "Approved" : "Needs your review"}`));
      row.append(element("span", `gate-number${gate.approved ? " approved" : ""}`, String(index + 1)), label,
        button("Review", () => navigate("review", gate.ref), "secondary small"));
      list.append(row);
    });
    gates.append(heading, list, element("p", "help-note", "Approvals apply only to the displayed version. Edits invalidate the affected downstream work."));
    grid.append(preview, gates); panel.append(grid);
  }
  panel.append(artifactInspector());
}

function artifactInspector(): HTMLElement {
  const card = element("div", "card artifact-card");
  if (!state) return card;
  const url = new URL(location.href);
  const id = url.searchParams.get("artifact");
  const version = Number(url.searchParams.get("version"));
  const candidates = state.artifacts.filter((record) => !record.id.startsWith("quality:"));
  const artifact = candidates.find((record) => record.id === id && record.version === version)
    ?? (id ? candidates.findLast((record) => record.id === id) : undefined)
    ?? (state.fixture ? candidates.find((record) => record.id === state!.fixture!.gates.find((gate) => !gate.approved)?.ref.id) : undefined)
    ?? currentRecords().find((record) => record.kind !== "workflow-report");
  const toolbar = element("div", "artifact-toolbar");
  const label = element("label", "", "Artifact & version");
  const select = element("select"); select.name = "artifact"; select.setAttribute("aria-label", "Artifact and version");
  for (const record of [...candidates].reverse()) {
    const option = element("option", "", `${record.id} / v${record.version}${record.invalidatedAt !== null ? " / invalidated" : ""}`);
    option.value = `${record.id}@${record.version}`; option.selected = record.id === artifact?.id && record.version === artifact.version;
    select.append(option);
  }
  select.addEventListener("change", () => {
    const record = candidates.find((candidate) => `${candidate.id}@${candidate.version}` === select.value);
    if (record) void navigate("review", record);
  });
  label.append(select); toolbar.append(label);
  if (artifact) toolbar.append(button("Edit typed manifest", () => {
    editing = !editing;
    editor.hidden = !editing;
    if (editing) textarea.focus();
  }, "secondary"));
  card.append(toolbar);
  if (!artifact) { card.append(element("p", "muted", "No artifacts yet. Save a brief or load the engineering fixture.")); return card; }
  const current = currentRecords().some((record) => record.id === artifact.id && record.version === artifact.version);
  const title = element("div", "artifact-title");
  title.append(element("h3", "", nameOf(artifact)), tag(artifact.kind), tag(`v${artifact.version}`),
    tag(current ? "Current" : "Invalidated", current ? "current" : "invalidated"));
  card.append(title, element("div", "meta", `SHA-256 ${artifact.hash.slice(0, 16)} / ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(artifact.createdAt)}`));
  const content = artifact.content;
  if ("script" in content) card.append(element("p", "artifact-copy", content.script));
  else if (artifact.kind === "script-storyboard" && "scenes" in content) {
    for (const scene of content.scenes) {
      if ("sceneId" in scene) card.append(element("h3", "", scene.sceneId), element("p", "artifact-copy", scene.script));
    }
  } else if ("objective" in content) card.append(element("p", "artifact-copy", content.objective));
  else if ("notes" in content) card.append(element("p", "artifact-copy", content.notes));
  else if ("summary" in content) card.append(element("p", "artifact-copy", content.summary));
  else card.append(element("p", "artifact-copy", "Review the validated manifest and exact dependency versions below."));
  if (artifact.invalidationReason) card.append(element("p", "field-error", artifact.invalidationReason));
  const details = element("details");
  details.append(element("summary", "", "Typed manifest & exact lineage"), element("pre", "", JSON.stringify({ content: artifact.content, dependencies: artifact.dependencies }, null, 2)));
  card.append(details);
  const editor = element("form", "editor"); editor.hidden = !editing;
  const editLabel = element("label", "", "Artifact content (JSON)");
  const textarea = element("textarea"); textarea.name = "artifact-content"; textarea.spellcheck = false; textarea.autocomplete = "off";
  textarea.value = JSON.stringify(artifact.content, null, 2); editLabel.append(textarea);
  const editError = element("p", "field-error"); editError.setAttribute("role", "alert");
  const save = element("button", "button primary", "Save new artifact version"); save.type = "submit";
  editor.append(editLabel, editError, save);
  editor.addEventListener("submit", (event) => {
    event.preventDefault();
    void perform(async () => {
      try {
        const value: unknown = JSON.parse(textarea.value);
        await post("/api/artifacts", { id: artifact.id, kind: artifact.kind, content: value, expectedVersion: artifact.version, dependencies: artifact.dependencies });
        dirty = false; editing = false;
        url.searchParams.delete("version"); history.replaceState(null, "", url);
        notify("Saved a new exact version. Affected approvals and downstream artifacts were invalidated."); await refresh(true);
      } catch (error) { editError.textContent = error instanceof Error ? error.message : "Fix the manifest."; textarea.focus(); throw error; }
    }, save);
  });
  card.append(editor);
  const gates: Partial<Record<ArtifactKind, ApprovalGate[]>> = {
    curriculum: ["curriculum"], lesson: ["lesson"], "script-storyboard": ["script-storyboard"],
    "style-sample": ["style"], "style-pack": ["style"], "skill-draft": ["skill-review"],
    "lesson-output": ["presenterMode" in content && content.presenterMode === "fixture" ? "fixture-review" : "first-lesson"],
    "presenter-sample": ["fixture-review"],
    "provider-policy": ["provider", "identity-data", "spend"],
  };
  if (gates[artifact.kind]?.length) {
    const actions = element("div", "review-actions");
    const gateLabel = element("label", "", "Review gate");
    const gateSelect = element("select"); gateSelect.name = "gate";
    for (const gate of gates[artifact.kind]!) { const option = element("option", "", gate); option.value = gate; gateSelect.append(option); }
    gateLabel.append(gateSelect);
    const noteLabel = element("label", "note", "Review note (optional)");
    const note = element("input"); note.name = "review-note"; note.autocomplete = "off"; note.maxLength = 4000; noteLabel.append(note);
    const decide = async (decision: "approved" | "rejected") => {
      if (decision === "rejected" && !await confirmChange("Reject or revoke this version?", "Rejecting a previously approved version invalidates its derived artifacts and downstream approvals. Other scenes remain reusable.")) return;
      await post("/api/decisions", { artifactId: artifact.id, version: artifact.version, gate: gateSelect.value, decision, note: note.value });
      dirty = false; notify(`Recorded ${decision} for ${artifact.id}@${artifact.version}.`); await refresh(true);
    };
    const approve = button(`Approve v${artifact.version}`, () => decide("approved"), "primary");
    const reject = button("Reject / revoke", () => decide("rejected"), "danger");
    approve.disabled = !current; reject.disabled = !current;
    actions.append(gateLabel, noteLabel, approve, reject); card.append(actions);
    const latest = state.decisions.findLast((decision) => decision.artifactId === artifact.id && decision.version === artifact.version && decision.invalidatedAt === null);
    if (latest) card.append(element("p", "help-note", `${latest.gate}: ${latest.decision}${latest.note ? ` / ${latest.note}` : ""}`));
  }
  const revision = element("form", "revision-form");
  revision.append(element("h3", "", "Request a targeted revision"), element("p", "muted", "This maps affected work and pauses for actual replacements. It does not pretend to regenerate a lesson."));
  const revisionLabel = element("label", "", "Change type");
  const change = element("select"); change.name = "change";
  for (const type of ["visual", "script", "audio", "captions"]) { const option = element("option", "", type); option.value = type; change.append(option); }
  revisionLabel.append(change);
  const reasonLabel = element("label", "", "Revision reason");
  const reason = element("input"); reason.name = "reason"; reason.required = true; reason.autocomplete = "off"; reason.maxLength = 4000;
  reason.placeholder = "Describe the specific correction"; reasonLabel.append(reason);
  const request = element("button", "button secondary", "Map affected revision"); request.type = "submit"; request.disabled = !current;
  revision.append(revisionLabel, reasonLabel, request);
  revision.addEventListener("submit", (event) => {
    event.preventDefault(); void perform(async () => {
      await post("/api/revisions", { target: refOf(artifact), change: change.value, reason: reason.value });
      dirty = false; notify("The revision map is queued. Unaffected artifacts remain reusable; replacement generation is not automatic."); await refresh(true); await navigate("workflows");
    }, request);
  });
  card.append(revision); return card;
}

function resumeInputs(job: PublicJob): ArtifactRef[] {
  const kinds = new Set(job.definition.stages.filter((stage) => job.stages.find((record) => record.id === stage.id)?.status !== "completed")
    .flatMap((stage) => stage.requirements.map((requirement) => requirement.kind)));
  return currentRecords().filter((record) => kinds.has(record.kind) && !job.input.artifacts.some((ref) => ref.id === record.id)).map(refOf);
}

function renderWorkflows(): void {
  if (!state) return;
  const panel = required("workflows-panel");
  const toolbar = element("form", "workflow-toolbar");
  const label = element("label", "", "Start an executable workflow");
  const select = element("select"); select.name = "workflow";
  for (const workflow of state.workflows) { const option = element("option", "", `${workflow.id} / v${workflow.version}`); option.value = workflow.id; select.append(option); }
  label.append(select);
  const artifactsLabel = element("label", "", "Initial inputs (select exact versions)");
  const artifacts = element("select"); artifacts.name = "workflow-artifacts"; artifacts.multiple = true; artifacts.size = 3;
  for (const record of currentRecords().filter((record) => record.kind !== "workflow-report")) {
    const option = element("option", "", `${record.id}@${record.version}`); option.value = `${record.id}@${record.version}`; artifacts.append(option);
  }
  artifactsLabel.append(artifacts);
  const start = element("button", "button primary", "Start workflow"); start.type = "submit";
  toolbar.append(label, artifactsLabel, start, button("Recover expired leases", async () => {
    await post("/api/recover", {}); notify("Expired work was reconciled. Live leases and completed stages were preserved."); await refresh(true);
  }, "secondary"));
  toolbar.addEventListener("submit", (event) => {
    event.preventDefault(); void perform(async () => {
      const chosen = new Set([...artifacts.selectedOptions].map((option) => option.value));
      await post("/api/jobs", { workflowId: select.value, artifacts: currentRecords().filter((record) => chosen.has(`${record.id}@${record.version}`)).map(refOf) });
      dirty = false; notify("Workflow queued. Missing inputs and owner decisions remain explicit pause states."); await refresh(true);
    }, start);
  });
  panel.replaceChildren(toolbar);
  if (!state.jobs.length) { panel.append(element("div", "empty-card", "No jobs yet. Start a workflow with your chosen inputs.")); return; }
  for (const job of [...state.jobs].reverse()) {
    const card = element("article", "card workflow-card");
    const head = element("div", "workflow-head");
    const name = element("div"); name.append(element("h2", "", job.workflowId), element("div", "meta", `v${job.workflowVersion} / ${job.id.slice(0, 8)} / ${job.skillPins.length} pinned skills`));
    const actions = element("div", "workflow-actions");
    actions.append(tag(job.status));
    const run = button(job.status === "paused" || job.status === "cancelled" ? "Resume" : "Run", async () => {
      await post(`/api/jobs/${encodeURIComponent(job.id)}/run`, { artifacts: resumeInputs(job) });
      dirty = false; notify("Job scheduled. Existing version pins, approvals and retry backoff remain enforced."); await refresh(true);
    }, "secondary small");
    run.disabled = ["running", "completed", "failed"].includes(job.status);
    const cancel = button("Cancel", async () => {
      if (!await confirmChange("Cancel this local job?", "The controller revokes its lease. Completed work remains durable and can be reused.")) return;
      await post(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, {}); dirty = false; notify("Cancelled the job's active lease; completed work was retained."); await refresh(true);
    }, "danger small");
    cancel.disabled = ["completed", "failed", "cancelled"].includes(job.status);
    actions.append(run, cancel); head.append(name, actions); card.append(head);
    if (job.reason) card.append(element("p", "workflow-reason", job.reason));
    const stages = element("div", "stages");
    for (const stage of job.stages) {
      const item = element("div", "stage");
      item.append(element("h3", "", stage.id), tag(stage.status), element("small", "", `${stage.attempts} execution attempts`));
      if (stage.error) { const details = element("details"); details.append(element("summary", "", "Pause / failure reason"), element("p", "tiny", stage.error)); item.append(details); }
      stages.append(item);
    }
    card.append(stages); panel.append(card);
  }
}

function renderSkills(): void {
  if (!state) return;
  const panel = required("skills-panel");
  const stack = element("div", "stack");
  for (const skill of state.skills) {
    const card = element("article", "card");
    const head = element("div", "skill-head"); head.append(element("h2", "", skill.name), tag(skill.promptOnly ? "Prompt only" : "Typed local adapter"));
    card.append(head, element("p", "muted", skill.promptOnly
      ? "Externally sourced, attributed CC BY 4.0 quality-loop instructions. This document cannot execute tools or grant approvals."
      : "Structural reference checks only. It does not verify facts, aesthetics, identity, speech quality or human acceptance."),
    element("div", "meta", `Version ${skill.version} / package SHA-256 ${skill.packageHash.slice(0, 20)}`),
    element("div", "metric-strip", skill.promptOnly ? "Pinned source: f2c462ee0727035719e4b5c8d69195f8ba4f1c4e" : `${skill.adapterId}@${skill.adapterVersion}`));
    stack.append(card);
  }
  const rule = element("div", "card");
  rule.append(element("h2", "", "The extraction boundary is one video."),
    element("p", "muted", "At 3 distinct work items, direct work can continue. Before a foreseeable batch of 4, or before an emerging fourth item, a reviewed tested skill must exist. Stable work-item IDs dedupe retries and resumed work."),
    element("p", "help-note", "A draft is not approval. New versions require independent skill-review and an installed allowlisted adapter. Active jobs keep their original version pins."));
  stack.append(rule); panel.replaceChildren(stack);
}

function renderQuality(): void {
  if (!state) return;
  const panel = required("quality-panel");
  if (!state.quality.length) {
    panel.replaceChildren(element("div", "empty-card", "No comparison verdict has been recorded yet. Technical checks and a blind quality win are different claims.")); return;
  }
  const stack = element("div", "stack");
  for (const round of state.quality) {
    const card = element("article", "card");
    const heading = element("div", "skill-head");
    heading.append(element("h2", "", `${round.piece} / round ${round.round}`), tag(round.status));
    const link = element("a", "", round.bar.name); link.href = round.bar.url; link.target = "_blank"; link.rel = "noopener noreferrer";
    card.append(heading, link, element("p", "muted", round.biggestGap || "The critic has not returned a verdict."),
      element("p", "help-note", round.blindVerdict ? `Blind verdict: ${round.blindVerdict}. Mapping disclosed only after comparison.` : "No blind win has been claimed."));
    const checks = element("ul", "quality-checks");
    for (const check of round.checks) checks.append(element("li", check.passed ? "" : "failed", `${check.passed ? "PASS" : "FAIL"} / ${check.name}: ${check.detail}`));
    card.append(checks);
    const evidence = element("details");
    evidence.append(element("summary", "", "Prompt, reference and audit evidence"), element("pre", "", JSON.stringify(round, null, 2)));
    card.append(evidence); stack.append(card);
  }
  panel.replaceChildren(stack);
}

required("tabs").addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>("a[data-tab]");
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
  const tab = link.dataset["tab"];
  if (tab && tab in tabs) { event.preventDefault(); void perform(() => navigate(tab as Tab)); }
});
required("load-fixture").addEventListener("click", () => {
  void perform(async () => { await post("/api/fixture", {}); notify("Loaded a clearly labeled engineering fixture. No inputs were approved automatically."); await refresh(true); },
    required<HTMLButtonElement>("load-fixture"));
});
required<HTMLFormElement>("brief-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = required<HTMLFormElement>("brief-form");
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  void perform(async () => {
    const data = new FormData(form);
    const field = (name: string) => String(data.get(name) ?? "").trim();
    const lines = (name: string) => field(name).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    try {
      await post("/api/artifacts", {
        id: `brief:${crypto.randomUUID()}`, kind: "course-brief", expectedVersion: 0,
        content: { title: field("title"), niche: field("niche"), audience: field("audience"), language: field("language"), objectives: lines("objectives"), prerequisites: lines("prerequisites") },
      });
      dirty = false; form.reset(); required("brief-error").textContent = "";
      notify("Saved your brief privately. Curriculum, provider and budget decisions were not inferred."); await refresh(true); await navigate("review");
    } catch (error) { required("brief-error").textContent = error instanceof Error ? error.message : "Fix the brief."; form.querySelector<HTMLInputElement>("input")?.focus(); throw error; }
  }, submit);
});
document.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) dirty = true;
});
window.addEventListener("beforeunload", (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("popstate", () => { editing = false; render(); });
void refresh(true);
setInterval(() => { void refresh(); }, 2000);

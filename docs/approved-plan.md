# Approved scope and delivery plan

This preserves the approved planning document as the product's source of truth.
Its greenfield and repository-selection statements describe the time of approval,
not the current implementation. The user subsequently selected
`abhishekdhoriya-git/ai-course-studio` and authorized its isolated implementation.
See the [implementation README](../README.md) for working slices, commands and
remaining gates. This plan is not evidence that a pilot, provider, budget,
identity sample, premium-style verdict or finished owner course is approved.

<!-- BEGIN APPROVED PLAN -->
# AI Course-Production Studio: Implementation Plan

## Objective and confirmed decisions

Build a reusable studio that transforms a course brief into a researched curriculum and a series of premium, edited explainer videos. The intended finished system uses the owner's consented digital likeness, voice, and speaking style; it does not require recording every lesson.

Confirmed with the user:

- Long-form lessons first; short-form adaptation later.
- Keep the studio niche-agnostic; the pilot subject remains undecided.
- Start with the existing GitHub Copilot license. Compare paid services, but purchase nothing.
- Use a local-first TypeScript/Node.js architecture, Remotion, and FFmpeg.
- Prove the production pipeline using an explicitly non-cloned placeholder presenter/voice before integrating the real digital twin.
- Require curriculum, script/storyboard, presenter sample, and first-lesson approval before scaling.
- No initial cloud deployment or automatic publishing.
- Build repository-local skills for repeated meaningful activities. Four or more occurrences within one video triggers skill extraction; retries, polling, and individual frame renders do not count.
- Define explicit, executable production and revision workflows, not just a collection of prompts.
- Evolve the proven workflow into a fully functional agentic system later, retaining approval boundaries.

This is a greenfield plan. No implementation repository has been selected or inspected, and no application code, identity clone, or media production has been created. Implementation requires a selected configured repository/folder and an isolated coding session.

## Reframed project prompt

Plan and build a local-first AI course-production studio that accepts a niche, audience, prerequisites, language, and learning goals, then creates a source-backed curriculum and polished long-form lesson videos. Each lesson must have a dedicated teaching objective, research, script, storyboard, narration, final transcript, and repeatable edit.

Use my own consented digital likeness and cloned voice after provider and data-handling approval. Capture my speaking style separately from vocal identity. Combine presenter A-roll with relevant B-roll, demonstrations, licensed music, captions, animations, and accurate custom graphics using Remotion or a justified alternative. Analyze supplied reference videos to extract reusable editing principles, not copy their protected assets, scripts, or identity.

Use current accessible YouTube, Instagram, and Facebook evidence to inform relevance while preserving prerequisite order and learning outcomes. Record evidence dates and access gaps; never fabricate trends or source support.

Use GitHub Copilot for development and supported agent orchestration, subject to account policies and usage limits. Separate those capabilities from external media services and rendering costs. Start with one complete placeholder-based lesson, integrate an approved digital twin, approve the first finished lesson, and only then scale to the course. Include durable job state, selective regeneration, quality checks, human review gates, and auditable outputs. Do not purchase services, upload identity recordings, or publish without explicit authorization.

Build local, versioned skills when a meaningful activity is required at least four times within one video. Define workflows that route validated inputs through those skills and tools, persist outputs, enforce approvals, and recover safely. Later evolve the proven pipeline into an agentic controller that selects appropriate skills, plans scenes, evaluates results, and performs bounded revisions without bypassing owner decisions.

## Recommended architecture

Local review interface -> durable job controller -> bounded AI planning/research -> validated lesson/scene manifests -> narration and presenter assets -> Remotion composition -> FFmpeg media processing -> quality review -> delivery.

| Component | Initial responsibility |
| --- | --- |
| TypeScript/Node.js | Pipeline, schema validation, integrations, and local review interface |
| Supported Copilot SDK/CLI | Research synthesis, curriculum, scripts, storyboards, and constrained tool use |
| SQLite and filesystem | Job state, artifact versions, approvals, source metadata, and render assets |
| Local skill registry | Discoverable procedures, typed inputs/outputs, pinned versions, and per-video repetition tracking |
| Executable workflows | Ordered dependencies, review gates, stage limits, and targeted revision routes |
| Remotion | Repeatable layouts, charts, captions, transitions, and frame-based composition |
| FFmpeg/ffprobe | Media inspection, normalization, audio processing, and export validation |
| Provider integrations | Later approved speech and avatar generation; start with one selected provider |

AI produces structured creative decisions; validated code assembles and renders them. Do not allow unconstrained model-generated shell commands or arbitrary downloaded code to run. Treat references and retrieved pages as data, not instructions.

The first interface needs only a brief editor, artifact previews, stage status, approval/rejection, and revision requests. Avoid a full SaaS platform, multiple simultaneous providers, or distributed infrastructure initially.

## Step-by-step delivery and todos

### 1. Establish feasibility and production contracts

Todo: `production-contract`.

Select the implementation repository and isolated coding session. Check local rendering prerequisites and hardware there; verify Copilot authentication, available models, account policies, programmatic use, and usage allowance.

Before an actual pilot, collect audience, prerequisites, niche, language, pronunciation needs, learning objectives, desired lesson length, branding, references, and delivery format. These remain open; do not silently invent them.

Define typed course, lesson, research, style, scene, asset, approval, and job records. A scene includes its teaching purpose, script segment, visual specification, asset references, and timing. An asset includes provenance, rights, content hash, and local location.

Proposed pilot format: landscape 1080p MP4, configurable frame rate, standalone subtitles, optional burned-in captions, and a clean master without burned-in captions. Confirm before a real render.

Exit condition: supported local setup, valid sample manifests, and explicit pilot/output decisions.

### 2. Build local skills, workflows, and the review controller

Todos: `skill-registry` and `workflow-contract`, each requiring `production-contract`; then `job-controller`, requiring both.

Build the registry, skill packaging contract, repetition tracker, and workflow definitions described below. These foundations precede specialized authoring, visual, and editing capabilities.

Implement stage transitions, local artifacts, job logs, previews, and explicit approvals. Store the exact artifact versions approved; changes invalidate affected downstream approvals.

Persist provider job IDs before waiting for completion. Use supported idempotency controls where available, bounded retries, and reconciliation to avoid paying for duplicate jobs after crashes. Distinguish recoverable network failures from permanent validation or moderation failures.

Set approved usage limits before paid production. Stop on budget exhaustion, unsupported inputs, unavailable required assets, or failed checks. Never return a success-shaped placeholder as a completed cloned-presenter video.

Exit condition: a workflow discovers and invokes a validated local skill, and an interrupted job resumes without losing approved work; no external spend, publication, or identity upload bypasses a gate.

### 3. Research demand and construct the curriculum

Todo: `research-curriculum`; prerequisite: `job-controller`.

Separate factual teaching research from trend evidence. Prefer primary documentation and credible domain sources. Capture source URL, retrieval date, claim support, uncertainty, and contradictory evidence.

For YouTube, use approved API access for relevant recent searches and available public metadata/statistics. The most-popular chart is a regional/category signal, not proof of demand for an arbitrary niche. Public views are not retention, watch time, or conversion analytics.

For Instagram and Facebook, inspect available permissions and legitimate data access before promising automation. Begin with permitted public evidence, owner-authorized insights/exports, and supplied references when broad discovery is unavailable. Report coverage by platform and region; do not bypass access restrictions.

Build modules and lesson prerequisites around learning outcomes. Present trend-driven suggestions as proposed revisions; approved course structure is not silently overwritten.

Exit condition: curriculum review passes with coherent progression, evidence-backed relevance, and visible coverage gaps.

### 4. Develop lesson research, script, and storyboard

Todo: `lesson-authoring`; prerequisite: `research-curriculum`.

For each lesson produce a research brief, claims/source mapping, objectives, explanation, worked examples, recap, narration script, and scene-by-scene storyboard.

Capture the owner's communication preferences and consented writing/speech examples separately from voice cloning. Review phrasing, technical pronunciations, pace, and teaching clarity.

Choose visuals because they explain the concept. Use charts only with sourced or explicitly illustrative data. Label hypothetical examples. Plan relevant B-roll and actual demonstrations; never portray a fabricated screen as real product behavior.

Exit condition: approved script/storyboard, supported factual claims, and identifiable visual assets or an explicit asset-generation plan.

### 5. Extract a repeatable reference-inspired style

Todo: `style-system`; prerequisite: `job-controller`.

When references are supplied, inspect the actual accessible video, representative frames, and audio. If inaccessible, request an authorized upload or samples rather than pretending to analyze it.

Describe presenter framing, studio look, typography, palette, visual density, caption behavior, pacing, transitions, music treatment, and explanatory visual patterns. Distinguish observed characteristics from proposed adaptations.

Create an executable style pack: versioned parameters, reusable Remotion scene templates, approved assets, and a skill with inputs, workflow, constraints, and quality examples. A prompt alone is not a repeatable editing system.

Preserve general editing principles; do not copy protected footage, music, branding, scripts, or another presenter's identity. No references are supplied yet, so an original starter style needs approval before pilot production.

Exit condition: approved style sample and reusable templates suitable for different topics.

### 6. Render the complete placeholder-based pilot

Todo: `placeholder-pilot`; prerequisites: `lesson-authoring`, `style-system`.

Use a clearly labeled non-cloned presenter treatment and an authorized sample or generic narration source whose license permits the intended prototype use. Do not imply that the owner's likeness or voice has been cloned.

Render presenter A-roll, relevant B-roll, graphical explanations, transitions, music where licensed, and captions. Use actual narration/audio alignment to set scene lengths; word-count estimates alone are insufficient. Generate the final transcript and subtitle timings from final audio, not just the original script.

Keep speech and music separate; apply configurable ducking, intelligibility checks, and loudness/peak measurements. Caption placement must not obscure diagrams or key text.

Exit condition: one complete, playable, premium-style lesson with supporting artifacts. It proves composition and editing, not clone quality.

### 7. Compare and integrate the consented digital twin

Todo: `digital-twin`; prerequisites: `placeholder-pilot`, separate provider/data/spend approval.

Compare candidates without purchasing:

| Candidate | What to evaluate |
| --- | --- |
| HeyGen | Own-person digital twin and linked voice; consent process; supported render and external-audio options |
| Synthesia | Personal-avatar eligibility, API availability, template flexibility, and export restrictions |
| ElevenLabs | Optional dedicated voice clone; ownership verification, pronunciation control, and interoperability with the chosen avatar provider |

Prefer one avatar provider's native voice initially if it meets quality requirements. Add a separate voice provider only if the improvement warrants integration complexity and its audio is supported.

Verify current plan access, commercial rights, quotas, output duration/resolution, watermarking, retention, deletion, identity rights, API costs, and provider moderation. Desktop subscriptions and API entitlements may differ.

Get explicit approval before transferring recordings. Follow the chosen provider's current enrollment and verification process; initial owner recording cannot be eliminated. Keep recordings and credentials out of git, logs, and general course artifacts.

Evaluate a consented sample for resemblance, pronunciation, rhythm, lip sync, facial artifacts, gesture repetition, and cut compatibility. A voice clone does not guarantee the owner's exact delivery or teaching style.

Exit condition: owner approves the clone sample; then the real-presenter lesson replaces the placeholder and passes first-lesson review.

### 8. Enforce quality checks and selective revision

Todo: `quality-revision`; prerequisite: `placeholder-pilot`. Apply again after `digital-twin`.

Automate schema/asset validation, source and rights coverage, subtitle bounds, missing media, decoding, dimensions, audio presence, clipping, unexpected silence, and output duration consistency. Adopt measurable thresholds through the pilot; do not invent an unexplained "premium score."

Test manifest failures, approval invalidation, interrupted jobs, duplicate-provider-job prevention, caption/audio alignment, and regeneration boundaries. Use focused render fixtures plus the real pilot.

Human review remains necessary for factual teaching quality, pronunciation, aesthetics, identity fidelity, subtle lip sync, and reference-style interpretation. Automated and AI critiques support but do not replace it.

Allow edits such as "replace this B-roll," "slow this explanation," or "fix this pronunciation." Regenerate affected scenes and downstream outputs while reusing unaffected assets; audio changes also rebuild relevant captions and timing.

Exit condition: a targeted correction produces a valid revised lesson without unnecessarily regenerating the entire course.

### 9. Scale to course delivery

Todo: `course-delivery`; prerequisites: `digital-twin`, `quality-revision`.

After first-lesson approval, queue remaining approved lessons with bounded concurrency and actual-cost tracking. Preserve shared glossary, course progression, branding, and presenter settings. Escalate new factual, licensing, identity, or quality uncertainties for review.

Deliver each lesson's MP4 master, captioned variant if selected, SRT/VTT captions, final transcript, script, storyboard, research/source report, asset/license manifest, and revision history. Deliver a course outline and module/lesson index.

Default delivery is local files; no uploading to social platforms or a course-hosting service. Publication and platform-specific synthetic-media disclosure are separate approval decisions.

Exit condition: the agreed course is rendered, reviewable, complete, and organized with no missing supporting materials.

### 10. Extend to short form after long-form acceptance

Future todo: `short-form`; prerequisite: `course-delivery`. Deferred from initial implementation.

Choose self-contained teaching excerpts, rewrite hooks without distorting claims, redesign vertical framing/captions, and preserve context. Re-render responsive scene templates; do not simply crop every landscape lesson.

## Local skill-building strategy

### Extraction rule

Track semantic activities per video using a stable activity key and a distinct work-item ID, such as one B-roll selection for each scene. Required repetitions come from the approved storyboard; actual occurrences are recorded durably.

When four occurrences are foreseeable, extract and validate the skill before executing that batch. When repetition emerges during revision, extract before the fourth distinct occurrence. Exclude retries, provider polling, frame iterations, and the controller invoking itself. Do not double-count a resumed work item.

Activities with fewer occurrences may remain direct workflow steps or existing tools. Do not turn every helper into a skill or duplicate a suitable existing skill. Once created, a skill is reusable across later videos; the extraction trigger remains per-video, not a cross-video counter.

Test the boundary at three versus four distinct work items, foreseeable batches, resume deduplication, and exclusion of retries. Track extracted skill usage and outcome quality.

### Skill packaging and candidate inventory

Proposed repository placement is `.github\skills\<skill-name>\SKILL.md`, with examples, small tool adapters, or supporting assets where necessary. Verify discovery support for the selected Copilot runtime during implementation. Keep executable tools, typed schemas, and Remotion components in normal source modules; skills instruct the agent how to use them.

Each skill defines its purpose and trigger, input/output contract, prerequisites, procedure, allowed tools, provenance rules, failure reporting, quality checks, and invocation examples. Registry metadata pins its version and validates outputs. A skill is not a credential container, an approval grant, or an arbitrary generated script.

Candidate inventory, activated by the repetition rule unless an existing reusable capability already suffices:

| Candidate skill | Repeated meaningful work item |
| --- | --- |
| `research-and-verify-claim` | Verify one distinct teaching claim against credible sources |
| `write-explainer-segment` | Write one storyboarded explanation using the course glossary |
| `source-broll` | Select and document rights for one scene's supporting media |
| `build-explainer-graphic` | Produce one accurate chart, diagram, or animation |
| `prepare-presenter-segment` | Generate one approved narration/presenter segment through the selected provider |
| `compose-scene` | Assemble one scene from approved assets and timing |
| `align-scene-captions` | Align and lay out one scene's captions against final audio |
| `mix-scene-audio` | Apply approved speech/music treatment to one scene |
| `review-scene` | Evaluate one scene against objective and human-review criteria |
| `revise-scene` | Apply one targeted edit and invalidate affected outputs |

Reference-derived style packs remain an explicit product requirement even when reference analysis itself happens fewer than four times. These include reusable instructions and executable style templates, not copied media.

Only add a skill after representative examples establish its contract. Drafted skills must be reviewed and tested before registration; do not silently rewrite active skills during production. Jobs pin versions and record which skills produced each artifact.

## Workflow definitions

Todo: `workflow-contract`. Proposed definitions live under `src\workflows\`, separate from CI configuration. Use typed stage definitions and the durable controller rather than launching a large fleet of agents. There is no workflow execution as part of planning.

| Workflow | Sequence and gates |
| --- | --- |
| Course planning | Brief -> factual and trend evidence -> curriculum draft -> owner approval -> lesson queue |
| Style calibration | Authorized references or original style -> observed style specification -> sample render -> owner approval -> versioned style pack |
| Lesson production | Approved lesson -> research -> script/storyboard -> owner approval -> skill-extraction preflight -> scene assets -> narration/presenter -> alignment -> composition -> render -> quality checks -> required human review -> local delivery |
| Presenter enrollment | Provider/data/spend approval -> owner recordings and verification -> sample generation -> owner approval -> first real-presenter lesson approval |
| Targeted revision | Requested edit -> affected scene/artifact mapping -> skill-extraction preflight -> regenerate affected assets -> rebuild timing/captions as needed -> checks -> renew required approvals -> revised export |
| Skill maintenance | Repetition identified -> reuse search -> draft contract/procedure -> examples and tests -> review -> register version -> invoke on the affected work |
| Course batch | First real-presenter lesson accepted -> approved remaining lessons -> bounded queue -> review exceptions and outputs -> course manifest and package |

Every stage declares input/output schemas, prerequisites, allowed skill/tool versions, relevant approval references, limits, retry classification, and downstream invalidation rules. Failures remain explicit: pause for missing input, fail invalid artifacts, or retry only recoverable operations. Independent scenes may be processed concurrently within approved resource limits; approvals and dependent stages remain ordered.

## Later phase: fully functional agentic studio

Todo: `agentic-upgrade`; prerequisites: accepted `course-delivery`, `skill-registry`, and `workflow-contract`. This is a later implementation phase, not a new autonomous run now.

The upgrade adds goal-directed planning and tool/skill selection on top of the working workflows. A controller decomposes approved lesson goals, selects registered capabilities, reviews structured results, proposes evidence-based corrections, and routes uncertain cases to the owner. It cannot approve its own spend, identity uploads, curriculum changes, or publication.

Start with one controller and role-specific instructions for research, teaching/scriptwriting, visual direction, editing, and quality review. These roles need not be separate agents or processes. Add delegation only where measured workload and context isolation justify it; avoid a multi-agent platform before the single-controller pipeline works.

The functional system must provide:

- A local interface for briefs, references, approvals, revisions, and exported artifacts.
- Durable course/lesson state, artifact lineage, glossary, approved style packs, and searchable skill metadata; do not use unbounded chat history as the database.
- Schema-validated planning, least-privilege tool access, and explicit permission enforcement outside model prompts.
- Registered skill selection, observable per-stage usage, bounded self-correction, and stopping rules for unresolved errors or exhausted budgets.
- Real integrations for approved avatar/voice generation and usable rendered output; mocks remain visibly limited to tests and the placeholder prototype.
- Resume/cancel controls and provider-job reconciliation, with content and version-aware reuse.
- An evaluation set covering different lesson shapes, subject matter, revisions, missing evidence, and failed services. Each run still needs a concrete audience, language, and teaching brief.

Acceptance requires end-to-end operation through the real review interface: create an approved course, produce lessons, discover and reuse skills, detect the fourth repetition, pause at gates, recover from interruption, apply a targeted revision, and deliver verified files. An agent conversation, generated prompts, or an architectural diagram alone is not a functional system.

Short-form adaptation and this agentic upgrade are separate later workstreams; neither silently expands the other's scope.

## Step 0 (added by user): adopt the `gauntlet-loop` skill and use it for implementation

Source: https://github.com/robonuggets/gauntlet-loop (skill at `.claude/skills/gauntlet-loop/SKILL.md`; CC BY 4.0, technique by Matt Shumer, skill by Jay E / RoboNuggets). Todo: `adopt-gauntlet-loop` (blocks `job-controller` and all quality-sensitive work).

**What it is:** a skill that turns a goal into one short (~120-180 word) prompt making an agent (1) set a real quality bar, (2) split work into small judgeable pieces, (3) run a builder and a separate harsh critic with fresh context per piece, (4) compare blind (labels stripped) against the bar with a binary "which is better" verdict plus the single biggest remaining gap, and (5) loop until ours wins. Exit is winning or the user stopping; never a round count; no self-scoring out of 10.

**The bar must be Named, Fetchable, Comparable.** Offer 2-3 hardest-reachable bars when none is given; add a measurable half (render time, loudness, caption error rate, test pass rate) where one exists. Keep prompts minimal; no spec over-reach.

**Steps:**
1. Make a local copy at `.github\skills\gauntlet-loop\SKILL.md` in the studio repo, preserving the CC BY 4.0 license and attribution in a NOTICE/README beside it. Do not rely on the remote.
2. Adapt only for portability: replace the Claude Code-only last two lines (`/loop`, `ultracode`) with "Keep looping until the critic picks ours. Run the builders and critics as parallel subagents." Document how this studio invokes it. Register it in the studio's skill registry as an externally sourced, version-pinned skill.
3. Study it, then apply it: write gauntlet prompts per quality-sensitive piece and run builder/critic pairs with blind A/B. Candidate pieces and bars: review UI (named best-in-class review tool, same viewport); lesson explanation (a named published explainer, same length); Remotion graphics/captions/pacing (frames/clips of a named reference video, used for analysis only; never copy protected assets); skill-registry/workflow code (a named repo's implementation plus tests/benchmarks as the measurable half).
4. Keep a live progress page of rounds, bars, blind verdicts and remaining gaps. Record every bar and verdict as auditable artifacts.
5. Constraints still hold: no purchases, no identity uploads, no publication; bars must be fetchable (if not, stop and report rather than hallucinate); the user's own reference videos, when supplied, become the primary bar for style work.

## Immediate next steps

0. Copy and adopt `gauntlet-loop` locally (above), then use it throughout implementation.

1. Approve this revised architecture and phased scope; no code creation is authorized by the plan alone.
2. Select an existing configured implementation repository/folder, or explicitly authorize adding a new one. Create an isolated coding session for implementation.
3. Build the local skill registry, repetition tracker, typed workflow contracts, job controller, and review gates first.
4. Choose the actual pilot brief and approve an original style or supply authorized references.
5. Implement and render the complete placeholder-based lesson, exercising reusable skills and targeted revision.
6. Separately approve a digital-twin provider, recordings/data handling, and budget; accept the first real-presenter lesson, then scale the course.
7. Upgrade the proven workflows into the functional agentic system; add short-form production when requested.

## Cost and autonomy boundaries

Copilot SDK usage consumes the account's allowance; premium model availability does not imply unlimited automation or third-party media generation. Verify account restrictions and supported SDK versions rather than automating the chat UI or borrowing internal model credentials.

Rendering uses local compute/storage. Remotion free commercial eligibility depends on individual/team conditions. FFmpeg distribution obligations depend on the build. Voice, avatar, licensed media/music, API usage, and optional cloud compute are independent costs.

Before paid production calculate a scenario from the approved course's narration volume, generated avatar duration, provider rates, expected revisions, media licenses, and rendering needs. Show assumptions and actual usage separately. No unverified price or total is promised here.

Automation executes approved work; it does not approve its own identity enrollment, spend, content claims, or publication.

## Open decisions and excluded scope

Still open: implementation repository, pilot niche, audience, language, lesson length, exact export settings, references/branding, media budget, clone provider, and any organizational data-policy restrictions.

Excluded initially: short-form generation, course storefront/LMS, payments, marketing campaigns, automated publication, broad unauthorized social scraping, multi-tenant hosting, custom avatar-model training, and guaranteed audience growth.

## Official source notes

- Copilot SDK repository and FAQ: https://github.com/github/copilot-sdk . Supports programmatic agent integration; standard use requires an eligible subscription and consumes the CLI usage allowance. The repository currently notes a transition to Microsoft Copilot SDK naming; verify packages when implementing.
- Remotion license/pricing: https://www.remotion.dev/docs/license/pricing . Free commercial use is documented for individuals and companies of up to three people, subject to terms.
- FFmpeg licensing: https://ffmpeg.org/legal.html .
- HeyGen own-person digital twin and consent: https://developers.heygen.com/docs/avatar-from-video .
- ElevenLabs professional voice-cloning and verification: https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/professional-voice-cloning .
- Synthesia documentation: https://docs.synthesia.io/docs . Provider entitlements and integration fit remain to be verified.
- YouTube video metadata/statistics and most-popular chart: https://developers.google.com/youtube/v3/docs/videos/list .
- Instagram supported account integrations: https://developers.facebook.com/documentation/instagram-platform . This is not an unrestricted cross-platform trend feed; Facebook discovery must also be assessed separately.

These sources establish capability boundaries, not a purchase recommendation or a guarantee of production quality.
<!-- END APPROVED PLAN -->

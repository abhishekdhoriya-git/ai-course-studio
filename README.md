# AI Course Studio

A local-first TypeScript/Node.js production desk with SQLite durability,
versioned artifacts, explicit human review gates and repository-local skills.
This repository is public; course data and media stay in ignored `.studio`
storage.

The [approved product plan](docs/approved-plan.md) preserves the original scope
and delivery gates. Its historical greenfield wording is not an implementation
status report; the working slices and remaining limits are documented here.

**Foundation slice:** seven executable workflows, typed manifests, an immutable
skill registry, per-video repetition tracking, bounded retries/recovery and a
usable loopback-only review UI. Unconfigured authoring and provider steps pause
with an explicit reason rather than fabricate completed work.

## Run locally

Use Node.js 24 and run these commands from the repository root:

```powershell
npm ci
npm run doctor
npm run check
npm run build
npm start
```

Open **http://127.0.0.1:4317**. The review desk provides a brief editor, artifact
previews, exact-version approval/rejection, JSON editing, workflow start/resume/
cancel, targeted revision mapping, skill pins and the live quality-loop page.

See [Using the studio](docs/using-studio.md) for reviewing the latest video,
editing a scene, regenerating it and starting a real course brief. The fixture
now uses narration-timed sequential reveals, drawn diagram connections and a
moving version focus rather than showing all teaching blocks at once.

`npm run test:ui` exercises actual browser flows using installed Microsoft Edge.
The core tests use isolated file-backed databases and injected test adapters;
they never call a paid media provider.

## Engineering fixture, not a pilot

Choose **Load engineering fixture** in the UI, or run `npm run fixture`.
It creates explicitly labeled drafts and an original still style sample.
Nothing is approved automatically. Review the current curriculum, style sample,
style pack, lesson and script/storyboard versions before rendering.

The fixture demonstrates studio contracts; it does not select your actual
subject, audience, language, lesson length, presenter provider, budget or brand.
The installed local pipeline uses Windows built-in synthetic speech, measured
word events, Remotion and FFmpeg. It produces a **1280x720, 24 fps engineering
fixture**, not the selected real pilot format: clean and captioned MP4 variants,
SRT/VTT and a final spoken-word transcript. Its presenter and voice are explicitly
non-cloned. No reference footage or music is used.

`npm run render:fixture` requires your current fixture input approvals. For an
isolated engineering verification, run:

```powershell
npm run render:fixture -- --verification
```

This opt-in command uses `.studio\verification` and visibly marked **test-harness
preflight decisions**, not owner approval of a pilot. Actual media is rendered
and checked; the job still pauses for final human `fixture-review`. To inspect
that dataset in the UI:

```powershell
$env:STUDIO_DATA = ".studio\verification"
npm start
```

The verification banner remains visible. Normal `npm start` uses your own review
dataset and never grants these test decisions. The speech adapter fixes output
to 16 kHz PCM before 48 kHz normalization so speech-event clocks match actual
audio. Missing voices, tools or failed media checks stop explicitly.

`npm run test:render` additionally copies the verification database into an
isolated test directory, checks unchanged approved-output reuse, revises one
script, injects a classified pre-render interruption, reopens the job and renders
the revision. It verifies that 3 unaffected scene assets and completed narration/
skill invocations remain unchanged. The source review dataset is not approved or
modified by this copied test. This opt-in check needs Windows speech; CI runs the
contract/build/browser checks without generating narration.

Script revisions use the original 4 vector layouts. A request for different
visuals or B-roll pauses until a compatible reviewed template/asset adapter is
installed; it is never silently ignored. Historical lesson versions preview
their own media, and downloads retain exact asset versions. A matching cached
render reuses its verification/approval references; `renderMs` describes the
execution that produced those measurements, not a fresh-render benchmark.
Animation/media source hashes and a versioned template are part of the render
recipe. A template update requires a new style review and a new output review;
unchanged narration and unrelated scene inputs remain reusable.

## Skills, workflows and durability

Local skills live in `.github\skills\<name>\SKILL.md`. Each admitted executable
package has typed adapter contracts, representative examples and a reviewed
version. SQLite snapshots its files and hashes; jobs pin the exact skill,
adapter and workflow versions. A changed active package needs a version bump
and independent review, not a silent production-time rewrite.

Extraction triggers at **4 distinct work items within one video**. A foreseeable
four-item batch stops before any affected work begins if a suitable reviewed
skill is missing. An emerging fourth stops before it starts. Retry, polling,
frame, controller and resumed-duplicate events never raise the count. Videos
never aggregate their counters.

The seven workflows under `src\workflows` are course planning, style calibration,
lesson production, presenter enrollment, targeted revision, skill maintenance
and course batch. See [their integration contract](src/workflows/README.md).

Replacing an artifact or revoking its approval invalidates affected derived
versions, approvals and jobs atomically. Unrelated scenes remain reusable.
Expired leases recover without rerunning completed stages; stale inputs and
cancelled workers cannot commit. Provider-operation test seams reconcile an
uncertain dispatch instead of blindly submitting again.

## Boundaries and remaining decisions

No purchases, provider calls, identity/voice uploads, cloud deployment or
publishing are implemented. Forged approvals cannot enable those adapters.
Fixtures and test-provider operations cannot unlock real-presenter course
batches. A new real pilot needs your content, provider/data-handling and budget
decisions, then the required current-version approvals.

The Copilot app/CLI supports `.github\skills` discovery
([official documentation](https://docs.github.com/en/copilot/concepts/customizations/agent-skills)).
This slice does not automate the chat UI, borrow model credentials or include
a programmatic Copilot SDK controller. Account/model allowance and policy are
not verified by a successful local build.

Keep credentials, recordings, generated media, databases and private references
out of commits. The server binds only to loopback, checks Host/Origin, requires
a review-session token for writes, validates JSON and serves only hashed private
media of allowlisted types.

## Quality and licenses

The vendored `gauntlet-loop` is pinned and attributed under CC BY 4.0; see its
[notice](.github/skills/gauntlet-loop/LICENSE.TXT). The first-party structural
review skill is MIT licensed. No reference footage, scripts, brand artwork or
identity are reused in the fixture.

`node --import tsx src\cli.ts quality-prepare` fetches the actual pinned Temporal
approval/retry source and prepares anonymous procedure comparison packets.
The live Quality page separates technical checks, blind verdicts and blockers.
It never converts unavailable evidence into a win. This is a narrow procedure
comparison, not a claim to replace or outperform Temporal's distributed platform.
The implementation's blind procedure comparison preferred the studio after a
revocation-fencing fix. The fetched Frame.io guided entry and HelloWorld logo
animation do not supply a comparable course-approval/premium-teaching style bar,
so those visual verdicts are explicitly blocked rather than fabricated.
A comparable authorized lesson/style reference remains a user decision.

Verify [Remotion eligibility](https://www.remotion.dev/docs/license/pricing)
before commercial/team production and the selected
[FFmpeg build obligations](https://ffmpeg.org/legal.html) before redistribution.
Native package binaries and generated media are not committed.

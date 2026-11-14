# Local workflow foundation

## Named implementation reference

The concrete comparison reference is **Temporal `samples-typescript`**, fetched at
commit `5cc28352ba94ee3e80a8c25c7b478edf55afa794`:

- [Typed workflow/activity boundary](https://github.com/temporalio/samples-typescript/blob/5cc28352ba94ee3e80a8c25c7b478edf55afa794/hello-world/src/workflows.ts).
- [Explicit retry interval, maximum attempts and deadline](https://github.com/temporalio/samples-typescript/blob/5cc28352ba94ee3e80a8c25c7b478edf55afa794/activities-examples/src/workflows.ts).
- [Injected activities, retry-once and exhausted-failure tests](https://github.com/temporalio/samples-typescript/blob/5cc28352ba94ee3e80a8c25c7b478edf55afa794/activities-examples/src/mocha/workflows.test.ts).

Those real files informed the narrow typed adapter boundary, finite attempts,
deadlines and injected failure tests. No Temporal code was copied, dependency
added, server started, or distributed execution promised. Here a single local
controller uses Node 24 SQLite transactions and fenced leases. The measurable
counterpart is the actual `node:test` acceptance suite below, not an asserted
benchmark or a claim that this replaces Temporal.

## Integration

```ts
import { join } from "node:path";
import { StudioStore } from "../storage/index.js";
import { SkillRegistry } from "../skills/index.js";
import { StudioController } from "../controller.js";

const store = new StudioStore(join(".studio", "studio.sqlite"));
const registry = new SkillRegistry(store);
await registry.load();
const controller = new StudioController(store, registry);
const brief = store.saveArtifact({
  id: "course-brief", kind: "course-brief",
  content: {
    title: "Owner-supplied title", niche: "Owner-supplied niche",
    audience: "Owner-supplied audience", language: "en",
    prerequisites: [], objectives: ["Owner-supplied learning objective"],
  },
});
const job = controller.start("course-planning", { artifacts: [brief] });
await controller.run(job.id); // Pauses for actual evidence; no invented curriculum.
// Save actual authored evidence, then controller.resume(job.id, [evidenceRef]).
// Owner actions call store.recordDecision({ artifactId, version, gate, decision }).
store.close();
```

`saveArtifact` returns `{id, version, hash}`. `latestArtifact`, `getArtifact`,
`listArtifacts`, `recordDecision`, `isApproved`, `listDecisions`, `listJobs`,
`getJob`, `listAttempts`, and `listSkillInvocations` provide the review surface.
Artifacts are schema-validated JSON; embedded typed references become exact
lineage edges automatically. Replacing a version or revoking approval atomically
invalidates affected derived artifacts, decisions and jobs. Historical content
is retained. Unrelated siblings remain reusable.
Adapters may specify exact per-output `dependencies`; omitting them conservatively
depends on the stage inputs. Embedded content references always add lineage,
so an explicit narrow scene dependency cannot hide its audio/caption references.
Revision-request targets and revision-plan affected/reusable lists are explicitly
historical references, not derived-output edges: their exact versions stay
auditable while the user's revision intent survives replacement of its target.

`run` claims a job transactionally. `runQueued({limit, concurrency})` is bounded;
it never recursively runs child batches. Only explicit `TransientError` faults
get durable backoff. Permanent errors do not retry. `recover()` requeues expired
leases, preserving completed stages. `cancel()` revokes the token before old work
can commit. `resume()` preserves unaffected stages and cannot replace pinned
inputs. Explicit additions may fill missing future inputs; a revision affecting
completed input kinds requires a new job. Call `recover` at application startup,
and `runQueued` from a bounded local worker or an explicit user action.

Every definition snapshots its stage graph, schema IDs, exact local adapter
versions, gates, invalidation dependencies, attempts, backoff and deadlines.
The installed workflow registry cannot silently alter an existing job.

## Skills and revisions

The local `review-artifacts` skill performs only structural reference checks.
Its shipped contract-test review is not human approval of course content.
The external gauntlet remains prompt-only, source-pinned and CC BY 4.0 licensed.
Documents never become shell commands or imported generated code.

Registry loading validates real package files, contracts, supported semantic
activities, examples and document/package hashes. SQLite archives every admitted
package. Same-version mutations fail. Archived pins continue using their original
documents and exact installed adapter version. New skill/version drafts require
an independent current `skill-review` approval; `load({dryRun:true})` tests a
candidate but does not register it. Maintenance may explicitly add a newly
reviewed skill name to a job, never upgrade an already pinned name.

Use `controller.repetitions.preflight(batches)` before any affected batch work,
then `record({eventId,videoId,activityKey,workItemId,kind:"work-item"})` immediately
before a distinct work item starts. The union of persisted planned items and
the entire proposed batch blocks at four without a suitable reviewed skill.
Emerging fourth work blocks before it starts. Retry, poll, frame, controller and
resume-only events do not count; stable work IDs dedupe across reopen.
Different videos never aggregate. The default lesson workflow also derives
foreseeable activities from its approved storyboard.

`planTargetedRevision(store,{targets,change})` returns exact descendants,
unaffected reusable versions, and required rebuild categories. Audio lineage
passes through timing/captions/composition; replacing it invalidates those
versions, not another scene. Revision mapping does not pretend to generate new
audio or a revised video. Supply actual newer versions of the stable target IDs
using `resume(jobId, replacements)`, then real rebuilt outputs and renewed reviews.

## Deliberate production limits

All seven workflows are executable, but authoring, evidence collection, actual
style observation, media rendering and digital-twin enrollment are not faked.
Missing inputs/resources pause with specific reasons. Actual local asset hashes
are checked; playable/measurement evidence must come from the media pipeline,
not a self-awarded quality score.

Provider dispatch, identity transfer, purchases and publishing are hard-disabled,
even with forged approvals. `ProviderOperationRunner` has only an explicitly
injected **test** adapter seam. Its ledger saves a dispatch intent before the
call and a remote ID before polling. Uncertain dispatch must reconcile the
original idempotency key and never blindly resubmit. Test operations and fixture
assets can never establish real-presenter production evidence.

Course batches check current curriculum/style/presenter/first-real-lesson and
remaining-lesson decisions, provider/data/spend policy and budget before queuing.
Fixture first lessons never qualify. Since no production provider/accounting
adapter is installed, real batch dispatch remains blocked; fake approvals cannot
turn the local foundation into an externally consequential service.

## Exact local acceptance commands

```powershell
npm run typecheck
node --import tsx --test tests\storage.test.ts tests\skills.test.ts tests\controller.test.ts tests\provider-operations.test.ts
npm test
```

The focused tests use file-backed databases, reopen them after interruption,
inject only local fake adapters, and cover three/four and foreseeable unions,
cross-video isolation, excluded/resumed events, immutable pins, stale inputs,
atomic descendant invalidation, lease fencing, completed-stage reuse, bounded
attempts, missing resources, uncertain provider dispatch, fixture batch bypass,
and independent skill-review enforcement.

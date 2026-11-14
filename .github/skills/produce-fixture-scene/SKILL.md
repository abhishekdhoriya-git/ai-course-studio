---
name: produce-fixture-scene
description: Route one engineering-fixture scene through the fixed local narration, measured caption alignment and original-graphics pipeline. Reuse for four or more distinct scenes inside one video; never use for a real identity clone or paid provider generation.
---

# Produce fixture scene

## Purpose
Produce one scene of the explicitly non-cloned engineering fixture using
compiled, versioned local tools. The pure contract adapter validates a plan;
it does not claim to have created audio, captions or playable media.

## Trigger
Preflight `produce-fixture-scene` work items from the approved storyboard.
Before a foreseeable four-scene batch, pin this reviewed package. One scene is
one semantic work item; audio normalization and caption grouping are parts of
that same scene production, not new helper/frame/retry work items.

## Inputs
`studio.fixture-scene.input@1`: `fixture: true`, the exact scene artifact
reference, and a typed scene containing its script, purpose and visual intent.
Inputs are explicit; no user preferences or default pilot/provider are inferred.

## Outputs
`studio.fixture-scene.output@1`: a `validated-plan`, script hash, scene/version,
fixed local operation, mandatory measured-audio checks, non-cloned disclosure
and human review requirement. Actual assets are separate durable outputs from
the installed fixture pipeline, never success-shaped placeholder strings.

## Prerequisites
Current fixture curriculum, original style, lesson and storyboard approvals.
The host must provide the exact compiled fixture adapters, Node 24 SQLite,
local Windows speech, Remotion and FFmpeg. Missing tools pause/fail explicitly.
Copying this document alone does not install those host capabilities.

## Procedure
1. Invoke only `studio.fixture-scene-contract@1.0.0` on the exact current scene.
2. The installed local pipeline uses plain-text Windows speech, measures its
   actual WAV and retains speech-boundary events. It never uploads recordings.
3. Normalize audio with the fixed FFmpeg adapter; derive cue times and transcript
   from final speech events/audio, validate bounds and write SRT/VTT.
4. Compose original vector graphics, preserve the non-cloned disclosure every
   frame, and keep captions outside teaching diagrams.
5. Persist hashed actual assets and their exact scene lineage. Reuse unchanged
   scene files on retry/resume, then stop at final human fixture review.

## Allowed tools
Only the installed typed local fixture adapters. No model-generated shell,
arbitrary downloaded code, provider spend, identity transfer or publishing.
Owner production and final-review approvals are never granted by this skill.

## Provenance
Original fixture scripts and graphics. Local built-in synthetic speech is
non-cloned; its distribution rights require separate review for a real pilot.
Record exact script/asset hashes and tool versions.

## Failure reporting
Reject unsupported non-fixture inputs and invalid schemas. Missing voices,
audio, speech boundaries, captions, or failed decoding are errors, not silence
or fake completed media. Retry only explicitly recoverable classified faults.

## Quality checks
The representative contract examples must pass before admission. Runtime
must inspect real media, duration, dimensions, speech/caption bounds, loudness
and peak levels. A validated plan is not a playable-video or aesthetic verdict.

## Examples
An original one-word fixture script yields its exact script hash and a validated
plan, not a generated asset. A revised exact scene version yields the same
script hash with the new source version, never an inherited content approval.

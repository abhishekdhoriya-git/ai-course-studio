---
name: review-artifacts
description: Validate local artifact references and report missing or stale inputs without pretending to perform factual, aesthetic, identity, or media review.
---

# Review artifacts

## Purpose
Run the deterministic, typed artifact-reference review adapter. Its limited result
never grants an approval or claims that a video, curriculum, or cloned presenter is good.

## Trigger
Review one distinct artifact work item, or validate the input manifest of a local workflow.
This registered capability is reusable across videos.

## Inputs
`studio.artifact-review.input@1`: a subject and artifact references, kinds, and current-version flags.
The controller obtains these flags from SQLite, not from model claims.

## Outputs
`studio.artifact-review.output@1`: checked count, explicit missing/stale issues, and
`humanReviewRequired: true`.

## Prerequisites
Load this exact package through the registry. Preserve version and document hashes.
Use current artifact references; content approval is a separate owner decision.

## Procedure
1. Validate inputs against the adapter schema.
2. Invoke only `studio.review-artifacts@1.0.0`.
3. Validate and durably record the output and outcome.
4. Pause the workflow for any separately required evidence or owner approval.

## Allowed tools
Only the allowlisted pure TypeScript adapter. No shell, generated code, provider,
purchase, identity transfer, or publishing authority.

## Provenance
First-party local contract. Preserve the exact artifact versions and package hash.
Reference review is not source verification.

## Failure reporting
Reject invalid input/output schemas. Report `NO_INPUTS` or `STALE_ARTIFACT` explicitly.
Do not replace missing evidence with plausible-looking content.

## Quality checks
The two executable contract examples in artefact.yaml must pass before admission.
The focused registry tests cover mutation, old pins, validation and the repetition guard.
Runtime skill drafts still require a separate version-aware skill-review approval.

## Examples
An empty manifest returns zero checked items, `NO_INPUTS`, and mandatory human review.
A stale reference returns `STALE_ARTIFACT`, not a successful content review.

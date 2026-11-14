# Gauntlet loop

**Author:** Jay E / RoboNuggets; technique by Matt Shumer.
**Version:** 1.0.0-portable. **License:** CC BY 4.0.

This is a repository-local copy, not a dependency on an installed remote skill.
Upstream: https://github.com/robonuggets/gauntlet-loop
Pinned commit: `f2c462ee0727035719e4b5c8d69195f8ba4f1c4e`.
Original file: `.claude/skills/gauntlet-loop/SKILL.md`.

The only instruction adaptation replaces the Claude-specific loop/ultracode
endings in the three example prompts with the upstream portability sentence.
No upstream endorsement is implied. See `LICENSE.TXT`.

## Installation and prerequisites

Copy this entire folder into a skill-capable host. A host needs independent
builder/critic contexts and a way to fetch the actual reference. No MCP server,
credentials, purchases, or provider accounts are required by the skill.

## Workflow and outputs

Invoke `gauntlet-loop` with a goal and a named, fetchable, comparable reference.
It produces a short prompt; it does not itself execute a production workflow.
This studio registers its exact document hash and uses fresh-context builder
and critic tasks. Comparison rounds, actual evidence, verdicts, remaining gaps,
and blocked comparisons are visible on the local review UI's Quality tab.
Unfetchable references are a blocker, not a passing verdict.

`SKILL.md` contains the portable instructions, `artefact.yaml` the source
metadata, and `LICENSE.TXT` the license and attribution notice.

## Preferences

No persistent preferences: goals and reference bars are explicit inputs.
No personal configuration belongs in this package.

## Changelog

- 1.0.0-portable: pin upstream, preserve attribution, apply its portability rule.

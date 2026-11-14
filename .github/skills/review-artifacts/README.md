# Local artifact-reference review

**Author:** AI Course Studio contributors. **Version:** 1.0.0. **License:** MIT.

This first-party package has two executable schema/safety contract examples and
focused registry tests. Its `contract-tests` review designation is deliberately
limited to that deterministic contract: it is **not human content approval**.

The registry admits only an adapter already compiled into the explicit local
allowlist. SKILL.md, YAML, examples and license are archived together in SQLite;
changing any package file requires a new version. Archived pins continue using
their original document and exact adapter version.

The skill-maintenance workflow does not confer this shipped capability's trust on
a newly drafted skill. Such a draft needs its own current `skill-review` decision,
passing examples, and an independently installed allowlisted adapter.

Use the adapter through `SkillRegistry.invoke`, not by executing the document.

## Installation and structure

This package is specific to the studio's compiled `studio.review-artifacts`
adapter. Copying the document alone does not install executable authority.
`SKILL.md` defines the procedure; `artefact.yaml` includes the schema IDs and two
executable examples; `LICENSE.TXT` preserves redistribution rights.

## Preferences

No persistent preferences. Subject and exact artifact references are explicit
invocation inputs, not personal defaults.

## Changelog

- 1.0.0: typed reference checks, durable outcomes, immutable registry snapshots.

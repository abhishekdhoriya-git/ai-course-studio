# Produce a local fixture scene

**Author:** AI Course Studio contributors. **Version:** 1.0.0. **License:** MIT.

This package is extracted before the fixture's foreseeable batch of 4 distinct
scene-production work items. It reuses the fixed speech, normalization,
alignment and graphics pipeline rather than creating a skill for every helper.

## Installation and structure

Use this package with AI Course Studio's compiled fixture adapters, Node 24,
Windows built-in speech, Remotion and FFmpeg. The package contains `SKILL.md`,
this README, `LICENSE.TXT` and `artefact.yaml` with two executable examples.
It cannot run in a generic host that lacks the declared local adapters.

## Workflow and outputs

The registry first validates the exact scene plan and pins its version/hash.
Actual local tools then create and measure audio, align final captions and
compose original graphics. The durable outputs are actual hashed local assets.
The contract adapter's `validated-plan` never represents a rendered scene.
Current-version content and final fixture review remain separate gates.

The shipped v1 contract is tested with the compiled allowlist. New versions
need an independent skill-review; jobs cannot silently upgrade their pins.

## Preferences

No persistent preferences. Scripts, exact references and fixture status are
explicit inputs. Real pilot subject, voice identity, provider and budget are
not defaults, and no personal data belongs in this package.

## Changelog

- 1.0.0: package one semantic scene-production procedure before the fourth scene.

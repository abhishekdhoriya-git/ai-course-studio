import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { canonicalJson, hashJson, sha256 } from "../domain/hash.js";
import { jsonSchema, keySchema, versionSchema } from "../domain/schemas.js";
import type { Json } from "../domain/schemas.js";
import { skillPinSchema } from "../domain/runtime.js";
import type { SkillPin } from "../domain/runtime.js";
import { MissingInputError, PolicyError, StudioError } from "../domain/errors.js";
import type { SkillSnapshot, StudioStore } from "../storage/store.js";
import { builtinSkillAdapters, validatedAdapterOutput } from "./adapters.js";
import type { LocalSkillAdapter, SkillAdapterContext } from "./adapters.js";

export const GAUNTLET_COMMIT = "f2c462ee0727035719e4b5c8d69195f8ba4f1c4e";
const frontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(1),
}).passthrough();
const localMetadataSchema = z.object({
  name: keySchema, version: versionSchema, license: z.string().min(1),
  execution: z.literal("local-adapter"),
  activityKeys: z.array(keySchema).min(1),
  adapter: z.object({ id: keySchema, version: versionSchema }).strict(),
  contracts: z.object({ input: keySchema, output: keySchema }).strict(),
  review: z.object({
    status: z.literal("reviewed"), kind: z.literal("contract-tests"), evidence: z.string().min(1),
  }).strict(),
  examples: z.array(z.object({ name: z.string().min(1), input: jsonSchema, output: jsonSchema }).strict()).min(2),
}).passthrough();
const requiredSections = [
  "Purpose", "Trigger", "Inputs", "Outputs", "Prerequisites", "Procedure",
  "Allowed tools", "Provenance", "Failure reporting", "Quality checks", "Examples",
];
const packageFiles = ["SKILL.md", "README.md", "LICENSE.TXT", "artefact.yaml"] as const;

function yamlValue(text: string): unknown {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new StudioError("SKILL_METADATA", document.errors.map((error) => error.message).join("; "));
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}
function samePin(a: SkillPin, b: SkillPin): boolean { return canonicalJson(a) === canonicalJson(b); }

export class SkillRegistry {
  readonly root: string;
  private readonly adapters = new Map<string, LocalSkillAdapter>();
  private active = new Map<string, SkillPin>();

  constructor(private readonly store: StudioStore, options: {
    root?: string; adapters?: LocalSkillAdapter[];
  } = {}) {
    this.root = options.root ?? join(process.cwd(), ".github", "skills");
    for (const adapter of [...builtinSkillAdapters, ...(options.adapters ?? [])]) {
      const key = `${adapter.id}@${adapter.version}`;
      if (this.adapters.has(key) || adapter.effect !== "local-pure") {
        throw new PolicyError("ADAPTER_ALLOWLIST", `Duplicate or unsafe local adapter: ${key}`);
      }
      this.adapters.set(key, adapter);
    }
  }

  async load(options: { dryRun?: boolean } = {}): Promise<SkillPin[]> {
    const root = realpathSync(this.root);
    const loaded = new Map<string, SkillPin>();
    for (const directory of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!directory.isDirectory()) continue;
      const folder = join(root, directory.name);
      this.assertLocalFile(root, folder);
      const files: Record<string, string> = {};
      for (const file of packageFiles) {
        const path = join(folder, file);
        this.assertLocalFile(root, path);
        files[file] = readFileSync(path, "utf8");
      }
      const document = files["SKILL.md"]!;
      const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document);
      if (!match) throw new StudioError("SKILL_FRONTMATTER", `${directory.name}: missing YAML frontmatter`);
      const frontmatter = frontmatterSchema.parse(yamlValue(match[1]!));
      if (frontmatter.name !== directory.name) throw new StudioError("SKILL_NAME", "Skill folder and frontmatter names must match");
      const rawMetadata = jsonSchema.parse(yamlValue(files["artefact.yaml"]!));
      const metadata = z.object({ name: keySchema, version: versionSchema, license: z.string() }).passthrough().parse(rawMetadata);
      if (metadata.name !== frontmatter.name) throw new StudioError("SKILL_NAME", "Skill metadata and frontmatter names must match");
      const packageHash = hashJson(files);
      const previous = this.store.getSkillSnapshot(metadata.name, metadata.version);
      if (previous && previous.pin.packageHash !== packageHash) {
        throw new StudioError("SKILL_VERSION_MUTATED", `Skill ${metadata.name}@${metadata.version} changed without a version bump`);
      }
      let pin: SkillPin;
      if (metadata.name === "gauntlet-loop") {
        const source = z.object({ url: z.literal("https://github.com/robonuggets/gauntlet-loop"), commit: z.literal(GAUNTLET_COMMIT) })
          .parse(metadata["source"]);
        if (source.commit !== GAUNTLET_COMMIT || metadata.license !== "CC-BY-4.0" || !files["LICENSE.TXT"]!.includes("Attribution")) {
          throw new StudioError("EXTERNAL_SKILL_PIN", "The external prompt-only skill must retain its source pin and CC BY 4.0 license");
        }
        pin = {
          name: metadata.name, version: metadata.version, packageHash, documentHash: sha256(document),
          promptOnly: true, adapterId: null, adapterVersion: null,
        };
      } else {
        const local = localMetadataSchema.parse(rawMetadata);
        for (const section of requiredSections) {
          if (!new RegExp(`^#{1,3} ${section}\\s*$`, "im").test(document)) {
            throw new StudioError("SKILL_CONTRACT", `${local.name}: missing ${section} section`);
          }
        }
        const adapter = this.adapters.get(`${local.adapter.id}@${local.adapter.version}`);
        if (!adapter) throw new PolicyError("ADAPTER_NOT_ALLOWED", `${local.name}: adapter is not explicitly allowlisted`);
        if (adapter.inputSchemaId !== local.contracts.input || adapter.outputSchemaId !== local.contracts.output) {
          throw new StudioError("SKILL_CONTRACT", `${local.name}: schema IDs do not match the typed adapter`);
        }
        if (local.activityKeys.some((key) => !adapter.activityKeys.includes(key))) {
          throw new StudioError("SKILL_CONTRACT", `${local.name}: claimed activities are not supported by the allowlisted adapter`);
        }
        for (const example of local.examples) {
          const input = adapter.inputSchema.parse(example.input);
          const output = validatedAdapterOutput(adapter, await adapter.execute(input, {
            jobId: "registry-contract-test", stageId: "examples", invocationKey: example.name, attempt: 1,
          }));
          if (canonicalJson(output) !== canonicalJson(adapter.outputSchema.parse(example.output))) {
            throw new StudioError("SKILL_EXAMPLE_FAILED", `${local.name}: example failed: ${example.name}`);
          }
        }
        pin = {
          name: local.name, version: local.version, packageHash, documentHash: sha256(document),
          promptOnly: false, adapterId: local.adapter.id, adapterVersion: local.adapter.version,
        };
      }
      if (!options.dryRun) {
        this.assertReviewed(pin);
        this.store.archiveSkill({ pin, document, metadata: rawMetadata, files });
      }
      loaded.set(pin.name, pin);
    }
    if (!options.dryRun) this.active = loaded;
    return [...loaded.values()].map((pin) => ({ ...pin }));
  }

  list(): SkillPin[] { return [...this.active.values()].map((pin) => ({ ...pin })); }
  pin(name: string): SkillPin {
    const pin = this.active.get(name);
    if (!pin) throw new MissingInputError("SKILL_MISSING", `Reviewed local skill not loaded: ${name}`);
    return { ...pin };
  }
  pinned(pin: SkillPin): SkillSnapshot {
    skillPinSchema.parse(pin);
    const snapshot = this.store.getSkillSnapshot(pin.name, pin.version);
    if (!snapshot || !samePin(snapshot.pin, pin) || sha256(snapshot.document) !== pin.documentHash
      || hashJson(snapshot.files) !== pin.packageHash || snapshot.files["SKILL.md"] !== snapshot.document) {
      throw new StudioError("SKILL_PIN_MISMATCH", `Pinned skill snapshot is unavailable or corrupt: ${pin.name}@${pin.version}`);
    }
    if (!pin.promptOnly && !this.adapters.has(`${pin.adapterId}@${pin.adapterVersion}`)) {
      throw new MissingInputError("PINNED_ADAPTER_MISSING", `Required adapter version unavailable: ${pin.adapterId}@${pin.adapterVersion}`);
    }
    this.assertReviewed(pin);
    return snapshot;
  }
  forActivity(activityKey: string, pin?: SkillPin): SkillPin | undefined {
    const candidates = pin ? [pin] : this.list();
    return candidates.find((candidate) => {
      const snapshot = this.pinned(candidate);
      if (candidate.promptOnly) return false;
      const metadata = localMetadataSchema.parse(snapshot.metadata);
      return metadata.activityKeys.includes(activityKey);
    });
  }

  async invoke(pin: SkillPin, input: unknown, context: SkillAdapterContext): Promise<Json> {
    this.pinned(pin);
    if (pin.promptOnly) throw new PolicyError("PROMPT_ONLY_SKILL", `${pin.name} is a prompt, not executable authority`);
    const adapter = this.adapters.get(`${pin.adapterId}@${pin.adapterVersion}`)!;
    const rawInput = jsonSchema.parse(input);
    const invocationId = this.store.beginSkillInvocation({ ...context, pin, input: rawInput });
    try {
      context.signal?.throwIfAborted();
      const validatedInput = adapter.inputSchema.parse(rawInput);
      const output = validatedAdapterOutput(adapter, await adapter.execute(validatedInput, context));
      context.signal?.throwIfAborted();
      this.store.finishSkillInvocation(invocationId, output, null);
      return output;
    } catch (error) {
      this.store.finishSkillInvocation(invocationId, null, error instanceof Error ? error.message : "Local adapter failed");
      throw error;
    }
  }

  private assertLocalFile(root: string, path: string): void {
    const link = lstatSync(path);
    const location = relative(root, realpathSync(path));
    if (link.isSymbolicLink() || location.startsWith(`..${sep}`) || location === "..") {
      throw new PolicyError("SKILL_PATH", "Skill packages cannot contain symlinks or escape the registry");
    }
  }
  private assertReviewed(pin: SkillPin): void {
    if (pin.promptOnly || (pin.name === "review-artifacts" && pin.version === "1.0.0"
      && pin.adapterId === "studio.review-artifacts" && pin.adapterVersion === "1.0.0")
      || (pin.name === "produce-fixture-scene" && pin.version === "1.0.0"
      && pin.adapterId === "studio.fixture-scene-contract" && pin.adapterVersion === "1.0.0")) return;
    const reviewed = this.store.listArtifacts({ kind: "skill-draft" }).some((artifact) => {
      const draft = z.object({
        name: z.string(), version: z.string(), documentHash: z.string(),
      }).passthrough().parse(artifact.content);
      return draft.name === pin.name && draft.version === pin.version && draft.documentHash === pin.documentHash
        && this.store.isApproved(artifact, "skill-review");
    });
    if (!reviewed) throw new MissingInputError("SKILL_REVIEW_REQUIRED", `New skill versions require an independent current skill-review decision: ${pin.name}@${pin.version}`);
  }
}

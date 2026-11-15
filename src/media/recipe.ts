import { join } from "node:path";
import { z } from "zod";
import { hashJson, sha256File } from "../domain/hash.js";
import { hashSchema } from "../domain/schemas.js";
import { FIXTURE_TEMPLATE_VERSION } from "./template.js";

export const FIXTURE_TEMPLATE_ID = "fixture:template";
export const fixtureTemplateSchema = z.object({
  version: z.literal(FIXTURE_TEMPLATE_VERSION), sourceHash: hashSchema,
  files: z.record(z.string(), hashSchema),
}).strict();
export type FixtureTemplate = z.infer<typeof fixtureTemplateSchema>;
const templateFiles = [
  "entry.tsx", "composition.tsx", "motion.ts", "contracts.ts",
  "template.ts", "recipe.ts", "pipeline.ts", "captions.ts", "tools.ts",
] as const;

export function fixtureTemplate(root: string): FixtureTemplate {
  const files = Object.fromEntries(templateFiles.map((name) => [name, sha256File(join(root, "src", "media", name))]));
  return { version: FIXTURE_TEMPLATE_VERSION, sourceHash: hashJson({ version: FIXTURE_TEMPLATE_VERSION, files }), files };
}

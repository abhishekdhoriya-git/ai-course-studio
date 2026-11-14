import { z } from "zod";
import type { StudioStore } from "../storage/store.js";
import { jsonSchema } from "../domain/schemas.js";

export const qualityRoundSchema = z.object({
  piece: z.enum(["foundation", "review-ui", "fixture-render", "skill-contract"]),
  round: z.number().int().positive(),
  prompt: z.string().min(1),
  bar: z.object({
    name: z.string().min(1), url: z.url(), fetchedAt: z.iso.datetime().nullable(),
    commit: z.string().nullable(),
  }).strict(),
  status: z.enum(["building", "awaiting-critic", "revise", "won", "blocked"]),
  blindVerdict: z.enum(["A", "B"]).nullable(),
  candidateMapping: z.object({ A: z.enum(["studio", "reference"]), B: z.enum(["studio", "reference"]) }).nullable(),
  biggestGap: z.string(),
  evidence: z.array(z.string()),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() }).strict()),
  recordedAt: z.iso.datetime(),
}).strict();
export type QualityRound = z.infer<typeof qualityRoundSchema>;

export function recordQualityRound(store: StudioStore, input: QualityRound): void {
  const round = qualityRoundSchema.parse(input);
  store.saveArtifact({
    id: `quality:${round.piece}:${round.round}`, kind: "workflow-report",
    content: {
      summary: `${round.piece} / round ${round.round} / ${round.status}`,
      data: { qualityRound: jsonSchema.parse(round) },
    },
  });
}

export function qualityRounds(store: StudioStore): QualityRound[] {
  return store.listArtifacts({ kind: "workflow-report" })
    .filter((artifact) => artifact.id.startsWith("quality:"))
    .map((artifact) => {
      const data = z.object({ data: z.object({ qualityRound: qualityRoundSchema }).passthrough() }).passthrough().parse(artifact.content);
      return data.data.qualityRound;
    });
}

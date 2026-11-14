import type { ArtifactRef } from "../domain/schemas.js";
import type { StudioStore } from "../storage/store.js";

export interface RevisionImpact {
  affected: ArtifactRef[]; reusable: ArtifactRef[]; rebuild: string[];
}
export function planTargetedRevision(
  store: StudioStore,
  request: { targets: ArtifactRef[]; change: "audio" | "visual" | "script" | "captions" },
): RevisionImpact {
  const affected = store.descendants(request.targets);
  const keys = new Set(affected.map((ref) => `${ref.id}@${ref.version}`));
  const rebuild = request.change === "audio" || request.change === "script"
    ? ["audio", "timing", "captions", "composition", "lesson-output"]
    : request.change === "captions" ? ["captions", "composition", "lesson-output"] : ["composition", "lesson-output"];
  return {
    affected,
    reusable: store.listArtifacts().filter((artifact) => !keys.has(`${artifact.id}@${artifact.version}`))
      .map(({ id, version, hash }) => ({ id, version, hash })),
    rebuild,
  };
}

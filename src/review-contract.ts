import type { ArtifactRecord, ArtifactRef, ApprovalGate } from "./domain/schemas.js";
import type { JobRecord, SkillPin } from "./domain/runtime.js";
import type { QualityRound } from "./quality/progress.js";

export interface ReviewDecision {
  artifactId: string; version: number; gate: ApprovalGate;
  decision: "approved" | "rejected"; note: string | null; invalidatedAt: number | null;
}
export type PublicJob = Omit<JobRecord, "leaseToken">;
export interface ReviewState {
  token: string;
  verificationMode: boolean;
  artifacts: ArtifactRecord[];
  jobs: PublicJob[];
  decisions: ReviewDecision[];
  workflows: { id: string; version: string; description: string; stageCount: number }[];
  skills: SkillPin[];
  quality: QualityRound[];
  fixture: {
    title: string; manifest: ArtifactRef | null; output: ArtifactRef | null; poster: ArtifactRef | null;
    gates: { ref: ArtifactRef; gate: ApprovalGate; approved: boolean }[];
    readyToRender: boolean;
  } | null;
  totals: { artifacts: number; jobs: number; invocations: number };
}

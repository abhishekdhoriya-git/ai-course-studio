export type FailureClassification = "transient" | "permanent" | "missing-input" | "policy" | "stale" | "lease-lost" | "cancelled";

export class StudioError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly classification: FailureClassification = "permanent",
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class MissingInputError extends StudioError {
  constructor(code: string, message: string) { super(code, message, "missing-input"); }
}
export class PolicyError extends StudioError {
  constructor(code: string, message: string) { super(code, message, "policy"); }
}
export class StaleInputError extends StudioError {
  constructor(message: string) { super("STALE_INPUT", message, "stale"); }
}
export class TransientError extends StudioError {
  constructor(code: string, message: string) { super(code, message, "transient"); }
}
export class LeaseLostError extends StudioError {
  constructor() { super("LEASE_LOST", "The job lease is no longer owned by this worker", "lease-lost"); }
}
export class SkillExtractionRequired extends MissingInputError {
  constructor(public readonly videoId: string, public readonly activityKey: string, public readonly count: number) {
    super("SKILL_EXTRACTION_REQUIRED", `${activityKey}: ${count} distinct work items in video ${videoId}; a reviewed, tested skill is required before execution`);
  }
}

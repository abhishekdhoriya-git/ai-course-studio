import { z } from "zod";
import { activityBatchSchema, skillPinSchema } from "../domain/runtime.js";
import type { ActivityBatch, SkillPin } from "../domain/runtime.js";
import { keySchema } from "../domain/schemas.js";
import { StudioError } from "../domain/errors.js";
import type { ActivityEventKind, StudioStore } from "../storage/store.js";
import type { SkillRegistry } from "./registry.js";

const eventSchema = z.object({
  eventId: keySchema, videoId: keySchema, activityKey: keySchema, workItemId: keySchema,
  kind: z.enum(["work-item", "retry", "poll", "frame", "controller", "resume"]),
  skill: skillPinSchema.optional(),
}).strict();

export class RepetitionTracker {
  constructor(private readonly store: StudioStore, private readonly registry: SkillRegistry) {}

  preflight(batches: ActivityBatch[], pinnedSkills?: readonly SkillPin[]): void {
    this.store.atomic(() => {
      const grouped = new Map<string, ActivityBatch>();
      for (const candidate of batches) {
        const batch = activityBatchSchema.parse(candidate);
        const key = JSON.stringify([batch.videoId, batch.activityKey]);
        const previous = grouped.get(key);
        if (previous && previous.skillName !== batch.skillName) throw new StudioError("ACTIVITY_SKILL_CONFLICT", "A batch cannot select two skills for one activity");
        grouped.set(key, previous ? { ...batch, workItemIds: [...previous.workItemIds, ...batch.workItemIds] } : batch);
      }
      for (const batch of grouped.values()) {
        const candidates = pinnedSkills ?? this.registry.list();
        const pin = candidates.find((candidate) => (!batch.skillName || candidate.name === batch.skillName)
          && this.registry.forActivity(batch.activityKey, candidate));
        this.store.reserveActivity({
          videoId: batch.videoId, activityKey: batch.activityKey, workItemIds: batch.workItemIds,
          ...(pin ? { pin } : {}),
        });
      }
    });
  }

  record(candidate: {
    eventId: string; videoId: string; activityKey: string; workItemId: string;
    kind: ActivityEventKind; skill?: SkillPin;
  }): void {
    const event = eventSchema.parse(candidate);
    const pin = this.registry.forActivity(event.activityKey, event.skill);
    this.store.recordActivityEvent({
      eventId: event.eventId, videoId: event.videoId, activityKey: event.activityKey,
      workItemId: event.workItemId, kind: event.kind, ...(pin ? { pin } : {}),
    });
  }
  count(videoId: string, activityKey: string): number { return this.store.activityItems(videoId, activityKey).length; }
}

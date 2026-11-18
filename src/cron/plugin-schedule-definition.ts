import { createHash } from "node:crypto";
import type { CronStoredJob } from "./types.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

/** All execution inputs; enablement and run state remain scheduler-owned mutable state. */
export function pluginScheduleDefinition(job: CronStoredJob): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          agentId: job.agentId,
          owner: job.owner,
          schedule: job.schedule,
          payload: job.payload,
          sessionTarget: job.sessionTarget,
          delivery: job.delivery,
          deleteAfterRun: job.deleteAfterRun,
          failureAlert: job.failureAlert,
          trigger: job.trigger,
          pacing: job.pacing,
        }),
      ),
    )
    .digest("hex");
}

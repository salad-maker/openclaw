import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { CronStoredJob } from "../cron/types.js";

type ScheduleOperation = {
  ownership: NonNullable<CronStoredJob["pluginSchedule"]>;
  assertCurrent: () => void;
};
const operations = new AsyncLocalStorage<ScheduleOperation>();

export function pluginScheduleId(
  ownership: Pick<NonNullable<CronStoredJob["pluginSchedule"]>, "pluginId" | "scope" | "intent">,
): string {
  return `plugin-${createHash("sha256")
    .update(JSON.stringify([ownership.pluginId, ownership.scope, ownership.intent]))
    .digest("hex")}`;
}

/** Private in-process admission, never minted by wire fields or a service operator. */
export function withPluginScheduleAuthority<T>(operation: ScheduleOperation, run: () => T): T {
  operation.assertCurrent();
  return operations.run(operation, run);
}

export function capturePluginScheduleAuthority(): ScheduleOperation | undefined {
  const operation = operations.getStore();
  operation?.assertCurrent();
  return operation;
}

import { createHash } from "node:crypto";
import {
  AUTOMATIONS_TOOL_NAME,
  isAutomationsToolName,
} from "../agents/tools/automations-tool-name.js";
import { createCronTool } from "../agents/tools/cron-tool.js";
import type { CronToolOptions } from "../agents/tools/cron-tool.types.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { callGatewayTool, shouldUseInProcessGatewayTool } from "../agents/tools/gateway.js";
import { isCronJobActive, requestActiveCronJobCancellation } from "../cron/active-jobs.js";
import { pluginScheduleDefinition } from "../cron/plugin-schedule-definition.js";
import { hasUnsettledCronTaskRunForJob } from "../cron/service/active-run-cancellation.js";
import type { CronStoredJob } from "../cron/types.js";
import { pluginScheduleId, withPluginScheduleAuthority } from "./plugin-schedule-authority.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

export type PluginScheduleReceipt = { id: string; intent: string };
export type OpenClawPluginToolSchedules = {
  admit(input: {
    intent: string;
    at: string;
    message: string;
    timeoutSeconds?: number;
  }): Promise<PluginScheduleReceipt>;
  resolve(intent: string): Promise<PluginScheduleReceipt | null>;
  inspect(
    receipt: PluginScheduleReceipt,
  ): Promise<{ job: unknown; runs: unknown; stopped: boolean }>;
  history(receipt: PluginScheduleReceipt, runId: string): Promise<unknown>;
  cancel(
    receipt: PluginScheduleReceipt,
  ): Promise<{ cancellation: "requested" | "confirmed-stopped" }>;
};

const sources = new WeakMap<object, CronToolOptions>();

/** The existing creator pipeline owns these mutable final-surface capture references. */
export function bindPluginScheduleSource(context: object, options: CronToolOptions): void {
  sources.set(context, options);
}

function nonblank(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

/** Restricted delegation to the real native automation tool; no service/operator fallback. */
export function createPluginToolSchedules(
  sourceContext: OpenClawPluginToolContext,
  context: OpenClawPluginToolContext,
  pluginId: string,
  assertInvocationCurrent: () => void,
): OpenClawPluginToolSchedules | undefined {
  const options = sources.get(sourceContext);
  const project = context.activeProjectKeys;
  if (
    !options ||
    context.senderIsOwner !== true ||
    !project ||
    project.length !== 1 ||
    ![
      context.agentId,
      context.requesterSenderId,
      context.messageChannel,
      context.agentAccountId,
      project[0],
    ].every((value) => nonblank(value, 2048))
  ) {
    return undefined;
  }
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        context.messageChannel,
        context.agentAccountId,
        context.requesterSenderId,
        context.agentId,
        project[0],
      ]),
    )
    .digest("hex");
  const agentId = context.agentId!;
  const cron = createCronTool(options);
  const assertCurrent = () => {
    assertInvocationCurrent();
    if (context.senderIsOwner !== true || !shouldUseInProcessGatewayTool({})) {
      throw new Error("Plugin scheduling requires the current local authenticated owner turn");
    }
    if (
      options.creatorToolAllowlistCaptureRef?.value?.source !== "final-executable-surface" ||
      !options.creatorToolAllowlist?.some((tool) =>
        isAutomationsToolName(typeof tool === "string" ? tool : tool.name),
      )
    ) {
      throw new Error("Native automations is unavailable in the final permitted tool surface");
    }
    getGatewayToolCallerIdentity()?.assertToolAllowed?.(AUTOMATIONS_TOOL_NAME);
  };
  const host = () => {
    assertCurrent();
    const gateway = getGatewayToolCallerIdentity()?.gatewayContextResolver?.();
    if (!gateway) {
      throw new Error("Local schedule execution authority unavailable");
    }
    return gateway;
  };
  const owned = (receipt: PluginScheduleReceipt) => {
    if (!nonblank(receipt?.id, 200) || !nonblank(receipt?.intent, 200)) {
      throw new Error("Invalid plugin schedule receipt");
    }
    const job: CronStoredJob | undefined = host().cron.getJob(receipt.id);
    if (
      !job ||
      job.pluginSchedule?.pluginId !== pluginId ||
      job.pluginSchedule.scope !== scope ||
      job.pluginSchedule.intent !== receipt.intent ||
      job.pluginSchedule.definition !== pluginScheduleDefinition(job)
    ) {
      throw new Error("Plugin schedule ownership or immutable definition unavailable");
    }
    return job;
  };
  const invoke = async (args: Record<string, unknown>) => {
    assertCurrent();
    const result = await cron.execute("plugin-schedule", args);
    assertCurrent();
    return result.details;
  };
  const underReceipt = <T>(receipt: PluginScheduleReceipt, action: () => T) => {
    const job = owned(receipt);
    return withPluginScheduleAuthority(
      {
        ownership: job.pluginSchedule!,
        assertCurrent: () => {
          owned(receipt);
        },
      },
      action,
    );
  };
  return {
    async resolve(intent) {
      if (!nonblank(intent, 200)) {
        throw new Error("Invalid native schedule intent");
      }
      const id = pluginScheduleId({ pluginId, scope, intent });
      await host().cron.readJob(id);
      if (!host().cron.getJob(id)) {
        return null;
      }
      const receipt = { id, intent };
      await underReceipt(receipt, () => invoke({ action: "get", jobId: id }));
      owned(receipt);
      return receipt;
    },
    async admit(input) {
      assertCurrent();
      const atMs = Date.parse(input.at);
      const now = Date.now();
      const timeoutSeconds = input.timeoutSeconds ?? 60;
      if (
        !nonblank(input.intent, 200) ||
        !nonblank(input.message, 8000) ||
        !Number.isFinite(atMs) ||
        atMs < now + 5000 ||
        atMs > now + 7 * 86400000 ||
        !Number.isInteger(timeoutSeconds) ||
        timeoutSeconds < 1 ||
        timeoutSeconds > 300
      ) {
        throw new Error("Invalid bounded one-shot schedule");
      }
      const job = {
        name: `Plugin ${pluginId} one-shot`,
        agentId,
        enabled: true,
        schedule: { kind: "at" as const, at: new Date(atMs).toISOString() },
        sessionTarget: "isolated" as const,
        wakeMode: "now" as const,
        payload: {
          kind: "agentTurn" as const,
          message: input.message,
          timeoutSeconds,
          toolsAllow: [],
        },
        delivery: { mode: "none" as const },
        deleteAfterRun: false,
        failureAlert: false as const,
      };
      const ownership = { pluginId, scope, intent: input.intent, definition: "" };
      const result = await withPluginScheduleAuthority({ ownership, assertCurrent }, () =>
        invoke({ action: "add", job }),
      );
      const accepted = result as { id?: string; job?: { id?: string } };
      const id = accepted?.job?.id ?? accepted?.id;
      if (!nonblank(id, 200)) {
        throw new Error("Native schedule receipt unavailable; do not redispatch");
      }
      const receipt = { id, intent: input.intent };
      owned(receipt);
      return receipt;
    },
    async inspect(receipt) {
      return await underReceipt(receipt, async () => {
        const job = await invoke({ action: "get", jobId: receipt.id });
        const runs = await invoke({ action: "runs", jobId: receipt.id });
        const current = owned(receipt);
        const stopped =
          !current.enabled &&
          !isCronJobActive(receipt.id) &&
          !hasUnsettledCronTaskRunForJob(receipt.id) &&
          current.state.runningAtMs === undefined &&
          current.state.queuedAtMs === undefined;
        return { job, runs, stopped };
      });
    },
    async history(receipt, runId) {
      if (!nonblank(runId, 512)) {
        throw new Error("Invalid native schedule run correlation");
      }
      return await underReceipt(receipt, async () => {
        const result = await callGatewayTool(
          "cron.history",
          {},
          { id: receipt.id, runId, limit: 200 },
        );
        owned(receipt);
        return result;
      });
    },
    async cancel(receipt) {
      return await underReceipt(receipt, async () => {
        await invoke({ action: "update", jobId: receipt.id, job: { enabled: false } });
        const job = owned(receipt);
        requestActiveCronJobCancellation(
          receipt.id,
          "Plugin-owned schedule cancellation requested",
        );
        const unsettled =
          isCronJobActive(receipt.id) ||
          hasUnsettledCronTaskRunForJob(receipt.id) ||
          job.state.runningAtMs !== undefined ||
          job.state.queuedAtMs !== undefined;
        return {
          cancellation: unsettled ? ("requested" as const) : ("confirmed-stopped" as const),
        };
      });
    },
  };
}

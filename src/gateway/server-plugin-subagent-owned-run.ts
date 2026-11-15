import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { captureSubagentRetainedWork } from "../agents/subagents/registry/subagent-registry-execution-cleanup.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  withInProcessGatewayRead,
} from "./server-plugin-in-process-dispatch.js";
import type { ResolvedInProcessGatewayDispatch } from "./server-plugin-in-process-dispatch.types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { requireSessionRowProjection } from "./session-row-projection-access.js";

type Observation = Awaited<ReturnType<NonNullable<PluginRuntime["subagent"]["getRun"]>>>;

type OwnedRunRequest = {
  sessionKey: string;
  runId: string;
  resolveGatewayContext?: GatewayContextResolver;
  runtimeLifetime?: AbortSignal;
};

export async function withPluginOwnedRun<T>(
  request: OwnedRunRequest,
  run: (prepared: Awaited<ReturnType<typeof preparePluginOwnedRun>>) => Promise<T>,
): Promise<T> {
  const scope = getPluginRuntimeGatewayRequestScope();
  const pluginId = normalizeOptionalString(scope?.pluginId);
  const sessionKey = normalizeOptionalString(request.sessionKey);
  const runId = normalizeOptionalString(request.runId);
  if (!pluginId || !sessionKey || !runId) {
    throw new Error("Owned subagent access requires plugin, session and run identities.");
  }
  request.runtimeLifetime?.throwIfAborted();
  return withInProcessGatewayRead(
    {
      method: "sessions.get",
      requestParams: { key: sessionKey },
      scope,
      resolveGatewayContext: request.resolveGatewayContext,
      callerAuthorityError: "Owned subagent caller authority is no longer current.",
    },
    async (resolved, assertReadCurrent) => {
      const assertCurrent = () => {
        request.runtimeLifetime?.throwIfAborted();
        assertReadCurrent();
      };
      const prepared = await preparePluginOwnedRun({
        resolved,
        pluginId,
        sessionKey,
        runId,
        assertCurrent,
      });
      prepared.assertCurrent();
      return await run(prepared);
    },
  );
}

export async function cancelPluginOwnedRun(
  request: OwnedRunRequest,
): Promise<Awaited<ReturnType<NonNullable<PluginRuntime["subagent"]["cancelRun"]>>>> {
  return withPluginOwnedRun(request, async ({ observation, assertCurrent }) => {
    const { runId, sessionKey } = observation;
    if (
      observation.status === "unknown" ||
      (observation.status === "terminal" && !observation.ownedWorkPending)
    ) {
      return { runId, sessionKey, status: "not-active" };
    }
    assertCurrent();
    const payload = await dispatchGatewayMethodInProcess<{
      status: string;
      abortedRunId: string | null;
    }>(
      "sessions.abort",
      { key: sessionKey, runId },
      {
        resolveGatewayContext: request.resolveGatewayContext,
        sessionMutationCommitGuard: assertCurrent,
        ...(!getPluginRuntimeGatewayRequestScope()?.client
          ? { operatorRoleActor: { kind: "system" as const } }
          : {}),
      },
    );
    assertCurrent();
    return {
      runId,
      sessionKey,
      status:
        payload.status === "aborted" && payload.abortedRunId === runId
          ? "acknowledged"
          : "not-active",
    };
  });
}

/** Physical session identity fences old runs after reset; labels are never authority. */
export function assertPluginOwnedRun(
  pluginId: string,
  sessionKey: string,
  runId: string,
  session: SessionEntry | undefined,
  run: SubagentRunRecord | undefined,
): void {
  if (
    !session ||
    session.pluginOwnerId !== pluginId ||
    !session.sessionId ||
    !session.lifecycleRevision ||
    (run &&
      (run.runId !== runId ||
        run.childSessionKey !== sessionKey ||
        run.childSessionIdentity?.sessionId !== session.sessionId ||
        run.childSessionIdentity?.lifecycleRevision !== session.lifecycleRevision))
  ) {
    throw new Error("Owned subagent run is unavailable to this plugin.");
  }
}

export function projectPluginOwnedRun(
  sessionKey: string,
  runId: string,
  run: SubagentRunRecord | undefined,
  ownedWorkPending = true,
): Observation {
  if (!run) {
    return { sessionKey, runId, status: "unknown", ownedWorkPending: true };
  }
  const completion = run.completion;
  return {
    sessionKey,
    runId,
    status: run.execution.status,
    ownedWorkPending,
    createdAt: run.createdAt,
    startedAt: run.execution.startedAt,
    endedAt: run.execution.endedAt,
    ...(run.execution.status === "terminal"
      ? {
          outcome:
            run.endedReason === "subagent-killed"
              ? "cancelled"
              : (run.execution.outcome?.status ?? "unknown"),
          error: run.execution.outcome?.error,
          ...(typeof completion?.resultText === "string" &&
          typeof completion.capturedAt === "number"
            ? {
                result: {
                  text: completion.resultText,
                  capturedAt: completion.capturedAt,
                  source: "native-subagent-completion" as const,
                },
              }
            : {}),
        }
      : {}),
  };
}

/** Called only while the dispatch owner holds live sessions.get authorization. */
export async function preparePluginOwnedRun(params: {
  resolved: ResolvedInProcessGatewayDispatch;
  pluginId: string;
  sessionKey: string;
  runId: string;
  assertCurrent: () => void;
}) {
  const { resolved, pluginId, sessionKey, runId } = params;
  const { prepareSubagentRunsByRunIds } =
    await import("../agents/subagents/registry/subagent-registry.js");
  params.assertCurrent();
  for (;;) {
    const prepared = await prepareSubagentRunsByRunIds([runId]);
    params.assertCurrent();
    const consumed = prepared.consume((rows) => {
      const run = rows.get(runId);
      const assertCurrent = () => {
        params.assertCurrent();
        const requested = resolveRequestedSessionAgentId(
          resolved.context.getRuntimeConfig(),
          sessionKey,
        );
        if (!requested.ok) {
          throw new Error("Owned subagent run is unavailable to this plugin.");
        }
        const projection = requireSessionRowProjection(resolved.context);
        const target = projection.capture({ key: sessionKey, agentId: requested.agentId });
        const session = target
          ? projection.readCapabilityEntry({
              agentId: target.agentId,
              key: target.key,
              storePath: target.storeTarget.storePath,
            })?.entry
          : undefined;
        assertPluginOwnedRun(pluginId, sessionKey, runId, session, run);
      };
      assertCurrent();
      return {
        observation: projectPluginOwnedRun(
          sessionKey,
          runId,
          run,
          !run || captureSubagentRetainedWork()(run),
        ),
        assertCurrent,
      };
    });
    if (consumed.ready) {
      return consumed.value;
    }
  }
}

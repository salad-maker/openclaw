import { addAbortListener } from "node:events";
import { isAbsolute, resolve } from "node:path";
import { getRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionAccessScope } from "../config/sessions/session-accessor.types.js";
import { sessionEntryCommitGuardOptions } from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry, PluginScopedTaskExecution } from "../config/sessions/types.js";
import { createAgentToolExecutionBudget } from "./agent-tool-source-execution-guard.js";
import { createCommandBudget } from "./command/maintenance-budget.js";
import type { prepareAgentCommandExecution } from "./command/prepare.js";
import type { AgentCommandOpts } from "./command/types.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import {
  withScopedTaskWorkspaceAuthority,
  resolveScopedTaskSandboxConfig,
} from "./sandbox/scoped-task-workspace.js";
import { isRuntimeToolAllowed } from "./tool-policy-match.js";

const fileTools = new Set(["read", "write", "edit", "apply_patch"]);

function assertTaskCanStart(task: PluginScopedTaskExecution, runId: string): void {
  if (
    task.version !== 1 ||
    task.runId !== runId ||
    task.executionStartedAt !== undefined ||
    !Number.isInteger(task.maxToolCalls) ||
    task.maxToolCalls < 1 ||
    task.maxToolCalls > 32 ||
    !Number.isInteger(task.timeoutSeconds) ||
    task.timeoutSeconds < 1 ||
    task.timeoutSeconds > 300 ||
    !Array.isArray(task.tools) ||
    task.tools.length === 0 ||
    task.tools.some((tool) => !fileTools.has(tool))
  ) {
    throw new Error(
      "Scoped task execution is already claimed or its exact run/budget is unavailable; never replay it",
    );
  }
}

/**
 * One native child command owns the budget across all attempts and tool wrappers.
 * Persisting the claim before execution intentionally sacrifices automatic retry:
 * after a crash even the same run ID cannot reset a budget or repeat a file effect.
 */
export async function runWithScopedTaskExecution<T>(
  params: {
    entry: InternalSessionEntry | undefined;
    scope: SessionAccessScope | undefined;
    sessionId: string;
    workspaceDir: string;
    config: OpenClawConfig;
    getConfig: () => OpenClawConfig;
    runId: string;
    signal: AbortSignal;
    abort: (reason: Error) => void;
    assertCurrent: () => void;
    acp: boolean;
    onClaimed: (entry: InternalSessionEntry, tools: string[]) => void;
  },
  run: () => Promise<T>,
): Promise<T> {
  const task = params.entry?.pluginScopedTask;
  if (!task) {
    return await run();
  }
  let deadline: ReturnType<typeof createCommandBudget> | undefined = undefined;
  const assertBaseCurrent = () => {
    deadline?.remainingMs();
    deadline?.signal.throwIfAborted();
    params.assertCurrent();
    params.signal.throwIfAborted();
    const entry = params.entry!;
    if (
      !entry.spawnedBy ||
      entry.sandbox !== "required" ||
      !entry.spawnedWorkspaceDir ||
      !isAbsolute(entry.spawnedWorkspaceDir) ||
      resolve(entry.spawnedWorkspaceDir) !== resolve(params.workspaceDir) ||
      !entry.sessionRoot ||
      resolve(entry.sessionRoot) !== resolve(params.workspaceDir)
    ) {
      throw new Error("Scoped task lost its required sandbox or original project workspace");
    }
    for (const config of [params.config, params.getConfig()]) {
      const sandbox = resolveSandboxConfigForAgent(config, params.scope?.agentId);
      if (
        sandbox.mode === "off" ||
        sandbox.backend !== "docker" ||
        sandbox.scope !== "session" ||
        sandbox.workspaceAccess !== "rw"
      ) {
        throw new Error(
          "Scoped task requires a session Docker sandbox with authorized rw workspace",
        );
      }
    }
  };
  let requireWorkspaceGrant = false;
  let workspaceAccess: "ro" | "rw" = "ro";
  const assertCurrent = () => {
    assertBaseCurrent();
    if (requireWorkspaceGrant) {
      for (const config of [params.config, params.getConfig()]) {
        const effective = resolveScopedTaskSandboxConfig({
          agentId: params.scope?.agentId,
          sessionKey: params.scope?.sessionKey,
          workspaceDir: params.workspaceDir,
          configured: resolveSandboxConfigForAgent(config, params.scope?.agentId),
        });
        if (
          !effective ||
          effective.workspaceAccess !== workspaceAccess ||
          effective.docker.network !== "none" ||
          (effective.docker.binds?.length ?? 0) !== 0 ||
          !effective.docker.readOnlyRoot
        ) {
          throw new Error("Scoped task lost its exact effective isolated workspace grant");
        }
      }
    }
  };
  assertCurrent();
  assertTaskCanStart(task, params.runId);
  if (!params.scope?.agentId || !params.entry?.pluginOwnerId || params.acp) {
    throw new Error("Scoped task requires a persisted plugin-owned native embedded session");
  }
  const persisted = await patchSessionEntryCore(
    params.scope,
    (_entry, context) => {
      const current = context.existingEntry;
      if (
        !current ||
        current.sessionId !== params.sessionId ||
        current.pluginOwnerId !== params.entry?.pluginOwnerId ||
        current.spawnedWorkspaceDir !== params.entry?.spawnedWorkspaceDir ||
        current.sessionRoot !== params.entry?.sessionRoot ||
        current.spawnedBy !== params.entry?.spawnedBy ||
        current.sandbox !== "required" ||
        current.pluginScopedTask?.intentSha256 !== task.intentSha256 ||
        current.pluginScopedTask.requestSha256 !== task.requestSha256 ||
        current.pluginScopedTask.scopeSha256 !== task.scopeSha256
      ) {
        throw new Error("Scoped task execution lost its original session ownership");
      }
      assertTaskCanStart(current.pluginScopedTask, params.runId);
      return { pluginScopedTask: { ...current.pluginScopedTask, executionStartedAt: Date.now() } };
    },
    {
      ...sessionEntryCommitGuardOptions(() => {
        assertCurrent();
      }),
      requireWriteSuccess: true,
    },
  );
  if (persisted?.pluginScopedTask?.executionStartedAt === undefined) {
    throw new Error("Scoped task execution claim was not persisted");
  }
  const claimedTask = persisted.pluginScopedTask;
  workspaceAccess = claimedTask.tools.some((tool) => tool !== "read") ? "rw" : "ro";
  deadline = createCommandBudget(
    persisted.pluginScopedTask.executionStartedAt,
    persisted.pluginScopedTask.timeoutSeconds * 1000,
    params.signal,
  );
  const abortAtDeadline = () => params.abort(deadline!.signal.reason);
  using _ = addAbortListener(deadline.signal, abortAtDeadline);
  try {
    if (deadline.signal.aborted) {
      abortAtDeadline();
    }
    return await withScopedTaskWorkspaceAuthority(
      {
        agentId: params.scope.agentId,
        sessionKey: params.scope.sessionKey,
        workspaceDir: params.workspaceDir,
        workspaceAccess,
        assertCurrent: assertBaseCurrent,
      },
      async () => {
        requireWorkspaceGrant = true;
        assertCurrent();
        params.onClaimed(persisted, [...claimedTask.tools]);
        const budget = createAgentToolExecutionBudget({
          maxToolCalls: claimedTask.maxToolCalls,
          requireNativeHarness: true,
          allowedToolNames: claimedTask.tools,
          signal: params.signal,
          abort: params.abort,
          isCurrent: () => {
            assertCurrent();
            return true;
          },
        });
        // Keep awaiting owned work after an abort; requesting interruption is not
        // evidence that an abort-ignoring provider has settled.
        const result = await budget.run(run);
        assertCurrent();
        return result;
      },
    );
  } finally {
    deadline.dispose();
  }
}

export function restrictScopedTaskCommandTools(
  opts: AgentCommandOpts,
  tools: string[],
): AgentCommandOpts {
  return {
    ...opts,
    toolsAllow: tools.filter((tool) => isRuntimeToolAllowed(tool, opts.toolsAllow)),
  };
}

export function scopedTaskExecutionParams(
  prepared: Awaited<ReturnType<typeof prepareAgentCommandExecution>>,
  entry: InternalSessionEntry | undefined,
  controller: AbortController,
): Omit<Parameters<typeof runWithScopedTaskExecution>[0], "assertCurrent" | "onClaimed"> {
  const {
    sessionAgentId,
    sessionKey,
    storePath,
    sessionId,
    runId,
    cwd,
    workspaceDir,
    cfg,
    acpResolution,
  } = prepared;
  return {
    entry,
    scope: sessionKey && storePath ? { agentId: sessionAgentId, storePath, sessionKey } : undefined,
    sessionId,
    runId,
    workspaceDir: cwd ?? workspaceDir,
    config: cfg,
    getConfig: () => getRuntimeConfigSnapshot() ?? cfg,
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    acp: acpResolution?.kind === "ready",
  };
}

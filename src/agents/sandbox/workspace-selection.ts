import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SkillSnapshot } from "../../skills/types.js";
import {
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "../admitted-run-context.js";
import type { ExecPolicyOverrides } from "../exec-defaults.js";
import type { WorkspaceStateGuard } from "../workspace-state-store.worker-contract.js";
import { resolveSandboxDependencyStore } from "./config-contract.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import type { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import { resolveScopedTaskSandboxConfig } from "./scoped-task-workspace.js";
import type { resolveSandboxSession } from "./session-selection.js";
const sandboxLog = createSubsystemLogger("agent/sandbox");

export type ResolveSandboxContextParams = {
  config?: OpenClawConfig;
  agentId?: string;
  execOverrides?: ExecPolicyOverrides;
  requireCurrentConfig?: boolean;
  assertCurrent?: () => void;
  abortSignal?: AbortSignal;
  admittedRunContext?: AdmittedRunContext;
  sessionKey?: string;
  skillsSnapshot?: SkillSnapshot;
  workspaceDir?: string;
  /** Classification already prepared for this session's workspace setup. */
  preparedRuntimeStatus?: ReturnType<typeof resolveSandboxRuntimeStatus>;
};

export type ResolvedSandboxSession = NonNullable<Awaited<ReturnType<typeof resolveSandboxSession>>>;

export async function prepareSandboxWorkspaceSelection(
  params: ResolveSandboxContextParams,
  resolved: ResolvedSandboxSession,
  guard?: WorkspaceStateGuard,
  operatorAuthority = readAdmittedRunOperatorAuthority(params.admittedRunContext),
  persistentExecution = false,
) {
  const { rawSessionKey, runtime } = resolved;
  const scopedTaskConfig = resolveScopedTaskSandboxConfig({
    agentId: runtime.agentId,
    sessionKey: rawSessionKey,
    workspaceDir: params.workspaceDir,
    configured: resolveSandboxConfigForAgent(params.config, runtime.agentId),
  });
  if (scopedTaskConfig) {
    if (!params.workspaceDir) {
      throw new Error("Scoped task sandbox allocation requires its exact project workspace");
    }
    // A claimed native task owns only its admitted current-project path. Do not
    // adopt a different managed guest projection or inherit parent mounts.
    return { rawSessionKey, runtime, cfg: scopedTaskConfig, localWorkspace: undefined };
  }
  params.assertCurrent?.();
  const localWorkspace = params.config
    ? await (
        await import("./local-workspace.js")
      ).prepareLocalSandboxWorkspace({
        cfg: params.config,
        agentId: runtime.agentId,
        sessionKey: rawSessionKey,
        workspaceDir: params.workspaceDir,
        sandbox: resolved.cfg,
        signal:
          params.abortSignal && operatorAuthority?.signal
            ? AbortSignal.any([params.abortSignal, operatorAuthority.signal])
            : (params.abortSignal ?? operatorAuthority?.signal),
        // Cleanup retains the workspace owner after execution authorization closes.
        assertCurrent: persistentExecution ? undefined : params.assertCurrent,
        stateOwnerPath: guard?.stateOwnerPath,
        assertHost: () => {
          if (persistentExecution) {
            guard?.assertHost?.();
            return;
          }
          if (params.admittedRunContext) {
            operatorAuthority?.assertCurrent();
            guard?.assertHost?.();
          } else {
            params.assertCurrent?.();
          }
        },
      })
    : undefined;
  try {
    const cfg = localWorkspace
      ? {
          ...resolved.cfg,
          scope: "session" as const,
          docker: resolveSandboxDependencyStore(resolved.cfg.docker),
          workspaceAccess:
            resolveSandboxConfigForAgent(params.config, runtime.agentId).workspaceAccess === "ro"
              ? ("ro" as const)
              : ("rw" as const),
        }
      : resolved.cfg;

    if (
      !localWorkspace &&
      runtime.sandboxRequired &&
      resolveSandboxConfigForAgent(params.config, runtime.agentId).workspaceAccess === "rw"
    ) {
      sandboxLog.warn(
        'Configured sandbox workspaceAccess "rw" is capped to "ro" for a role-required session; guests cannot share the writable agent workspace.',
      );
    }
    return { rawSessionKey, runtime, cfg, localWorkspace };
  } catch (error) {
    localWorkspace?.[Symbol.dispose]();
    throw error;
  }
}

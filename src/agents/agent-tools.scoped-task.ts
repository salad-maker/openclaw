import type { SkillSnapshot } from "../skills/types.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import type { InternalCodingToolsOptions } from "./agent-tools.options.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { prepareCoreToolPolicy } from "./prepared-tool-surface.js";
import { requireScopedTaskToolWorkspace } from "./sandbox/scoped-task-workspace.js";

export type PreparedCoreToolSurface = {
  tools?: AnyAgentTool[];
  policy: ReturnType<typeof prepareCoreToolPolicy>;
};

/** Preserve permission/approval modes while rebuilding only scoped native file tools. */
export function restrictScopedTaskToolConstruction(
  options: InternalCodingToolsOptions | undefined,
  skillReadResources: SkillSnapshot["resolvedSkills"] | undefined,
  preparedSurface: PreparedCoreToolSurface | undefined,
) {
  const sessionKey = options?.runSessionKey ?? options?.sessionKey;
  const sandbox = options?.sandbox?.enabled ? options.sandbox : undefined;
  const grant = requireScopedTaskToolWorkspace({
    agentId:
      options?.agentId ??
      (sessionKey ? resolveSessionAgentId({ config: options?.config, sessionKey }) : undefined),
    sessionKey,
    workspaceDir: options?.workspaceDir ?? sandbox?.workspaceDir,
  });
  if (!grant) {
    return { options, skillReadResources, preparedSurface, scopedTask: false };
  }
  if (
    !sandbox?.required ||
    sandbox.workspaceAccess !== grant.workspaceAccess ||
    sandbox.workspaceDir !== grant.workspaceDir ||
    !sandbox.fsBridge
  ) {
    throw new Error("Scoped task file tools require their exact effective sandbox");
  }
  const currentPolicy = prepareCoreToolPolicy({ ...options, requireWorkspaceOnly: true });
  return {
    scopedTask: true,
    options: {
      ...options,
      requireWorkspaceOnly: true as const,
      skillsSnapshot: undefined,
      skillUsagePaths: undefined,
      toolConstructionPlan: {
        includeBaseCodingTools: options?.toolConstructionPlan?.includeBaseCodingTools ?? true,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    },
    skillReadResources: undefined,
    // Never reuse a closure constructed with a broader root or older owner.
    // Retain stricter prepared policy, while making containment non-negotiable.
    preparedSurface: preparedSurface
      ? {
          policy: {
            ...currentPolicy,
            readOnly: currentPolicy.readOnly || preparedSurface.policy.readOnly,
            applyPatchEnabled:
              currentPolicy.applyPatchEnabled &&
              preparedSurface.policy.applyPatchEnabled &&
              !preparedSurface.policy.readOnly,
            workspaceOnly: true,
            applyPatchWorkspaceOnly: true,
            applyPatchContainmentSource: "required-root" as const,
          },
        }
      : undefined,
  };
}

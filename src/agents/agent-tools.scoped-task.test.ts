import { describe, expect, it, vi } from "vitest";
import type { InternalCodingToolsOptions } from "./agent-tools.options.js";
import { restrictScopedTaskToolConstruction } from "./agent-tools.scoped-task.js";
import { prepareCoreToolPolicy } from "./prepared-tool-surface.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import { withScopedTaskWorkspaceAuthority } from "./sandbox/scoped-task-workspace.js";

const owner = {
  agentId: "main",
  sessionKey: "agent:main:subagent:task",
  workspaceDir: "/fixture/project",
  workspaceAccess: "rw" as const,
  assertCurrent() {},
};
function options(): InternalCodingToolsOptions {
  const configured = resolveSandboxConfigForAgent(undefined, "main");
  return {
    agentId: owner.agentId,
    sessionKey: owner.sessionKey,
    workspaceDir: owner.workspaceDir,
    sandbox: {
      enabled: true,
      required: true,
      backendId: "docker",
      sessionKey: owner.sessionKey,
      workspaceDir: owner.workspaceDir,
      agentWorkspaceDir: owner.workspaceDir,
      workspaceAccess: "rw",
      runtimeId: "fixture",
      runtimeLabel: "fixture",
      containerName: "fixture",
      containerWorkdir: "/workspace",
      docker: configured.docker,
      tools: configured.tools,
      browserAllowHostControl: false,
      fsBridge: {
        resolvePath: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdirp: vi.fn(),
        remove: vi.fn(),
        rename: vi.fn(),
        stat: vi.fn(),
      },
    },
  };
}

describe("scoped native file-tool construction", () => {
  it("preserves unset permissions and normal construction, but clamps claimed tasks", async () => {
    const input = options();
    expect(restrictScopedTaskToolConstruction(input, undefined, undefined).scopedTask).toBe(false);
    await withScopedTaskWorkspaceAuthority(owner, async () => {
      const result = restrictScopedTaskToolConstruction(input, undefined, undefined)!;
      expect(result.options?.sessionPermissionPolicy).toBeUndefined();
      expect(result.options?.requireWorkspaceOnly).toBe(true);
      expect(result.options?.toolConstructionPlan).toEqual({
        includeBaseCodingTools: true,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      });
      expect(result.options?.sandbox).toBe(input.sandbox);
      expect(() =>
        restrictScopedTaskToolConstruction(
          { ...input, sessionKey: "agent:main:other" },
          undefined,
          undefined,
        ),
      ).toThrow();
      expect(() =>
        restrictScopedTaskToolConstruction({ ...input, sandbox: null }, undefined, undefined),
      ).toThrow("exact effective sandbox");
    });
  });

  it.each(["current", "cached"] as const)(
    "retains %s read-only policy and discards prepared closures",
    async (restricted) => {
      const input = options();
      if (restricted === "current") {
        input.sessionPermissionPolicy = { root: owner.workspaceDir, mode: "read-only" };
      }
      const policy = prepareCoreToolPolicy({
        sessionPermissionPolicy:
          restricted === "cached" ? { root: owner.workspaceDir, mode: "read-only" } : undefined,
      });
      await withScopedTaskWorkspaceAuthority(owner, async () => {
        const result = restrictScopedTaskToolConstruction(input, undefined, { tools: [], policy })!;
        expect(result.preparedSurface).not.toHaveProperty("tools");
        expect(result.preparedSurface?.policy).toMatchObject({
          readOnly: true,
          applyPatchEnabled: false,
          workspaceOnly: true,
        });
        expect(result.options?.sessionPermissionPolicy).toBe(input.sessionPermissionPolicy);
      });
    },
  );

  it("preserves explicit full mode while requiring project containment", async () => {
    const input = options();
    input.sessionPermissionPolicy = { root: owner.workspaceDir, mode: "full" };
    await withScopedTaskWorkspaceAuthority(owner, async () => {
      const result = restrictScopedTaskToolConstruction(input, undefined, {
        tools: [],
        policy: prepareCoreToolPolicy({}),
      })!;
      expect(result.options?.sessionPermissionPolicy).toBe(input.sessionPermissionPolicy);
      expect(result.preparedSurface?.policy).toMatchObject({
        workspaceOnly: true,
        applyPatchWorkspaceOnly: true,
        applyPatchContainmentSource: "required-root",
      });
    });
  });
});

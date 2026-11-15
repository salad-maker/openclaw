import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import {
  readScopedTaskWorkspaceAuthority,
  resolveScopedTaskSandboxConfig,
  withScopedTaskWorkspaceAuthority,
} from "./scoped-task-workspace.js";

const owner = {
  agentId: "main",
  sessionKey: "agent:main:subagent:scoped",
  workspaceDir: "/fixture/project",
  workspaceAccess: "rw" as const,
  assertCurrent() {},
};
const config: OpenClawConfig = {
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        scope: "session",
        workspaceAccess: "rw",
        docker: {
          network: "fixture-network",
          binds: ["/fixture/extra:/extra"],
          readOnlyRoot: false,
          env: { FIXTURE_PRIVATE: "sentinel" },
          setupCommand: "touch fixture-setup",
        },
        browser: { enabled: true },
      },
    },
  },
};
const runtime = (sessionKey = owner.sessionKey) =>
  resolveSandboxRuntimeStatus({
    cfg: config,
    agentId: owner.agentId,
    sessionKey,
    preparedSessionEntry: { sandbox: "required" },
  });

describe("claimed scoped task workspace authority", () => {
  it("preserves required guest read-only isolation and grants only the active exact task", async () => {
    expect(runtime().workspaceAccess).toBe("ro");
    await withScopedTaskWorkspaceAuthority(owner, async () => {
      expect(runtime()).toMatchObject({
        sandboxed: true,
        sandboxRequired: true,
        workspaceAccess: "rw",
      });
      expect(runtime("agent:main:subagent:other").workspaceAccess).toBe("ro");
      expect(readScopedTaskWorkspaceAuthority({ ...owner, agentId: "other" })).toBeUndefined();
      expect(() =>
        readScopedTaskWorkspaceAuthority({ ...owner, workspaceDir: "/outside" }),
      ).toThrow("substitute");
    });
    expect(runtime().workspaceAccess).toBe("ro");
  });

  it("narrows only the child allocation and preserves the parent's configuration", async () => {
    const configured = resolveSandboxConfigForAgent(config, owner.agentId);
    const before = JSON.stringify(configured);
    await withScopedTaskWorkspaceAuthority(owner, async () => {
      expect(resolveScopedTaskSandboxConfig({ ...owner, configured })).toMatchObject({
        scope: "session",
        workspaceAccess: "rw",
        docker: {
          network: "none",
          binds: [],
          readOnlyRoot: true,
          capDrop: ["ALL"],
          env: {},
          setupCommand: undefined,
        },
        browser: { enabled: false },
      });
      expect(JSON.stringify(configured)).toEqual(before);
      expect(() =>
        resolveScopedTaskSandboxConfig({
          ...owner,
          configured: { ...configured, workspaceAccess: "ro" },
        }),
      ).toThrow("lost its configured");
    });
  });

  it("revokes retained callbacks after settlement or a native owner loss", async () => {
    let retained!: () => void;
    let current = true;
    await withScopedTaskWorkspaceAuthority(
      {
        ...owner,
        assertCurrent() {
          if (!current) {
            throw new Error("owner ended");
          }
        },
      },
      async () => {
        retained = readScopedTaskWorkspaceAuthority(owner)!.assertCurrent;
        current = false;
        expect(retained).toThrow("owner ended");
        current = true;
        await expect(withScopedTaskWorkspaceAuthority(owner, async () => {})).rejects.toThrow(
          "one exact native owner",
        );
      },
    );
    expect(retained).toThrow("closed");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  bindPluginScopedTaskSource,
  createPluginToolScopedTasks,
  type ScopedTaskPreparationRequest,
} from "./tool-scoped-tasks.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

const caller = vi.hoisted(() => vi.fn());
const spawn = vi.hoisted(() => vi.fn());
vi.mock("../agents/subagents/spawn/subagent-spawn.js", () => ({ spawnSubagentDirect: spawn }));
vi.mock("../agents/tools/gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: caller,
}));

const request: ScopedTaskPreparationRequest = {
  intent: "fixture-intent",
  spec: {
    role: "worker",
    tools: ["read", "write"],
    timeoutSeconds: 30,
    maxToolCalls: 3,
    handoff: false,
  },
  workspace: "current-project",
  sandbox: "required",
  network: "none",
};

function fixture() {
  const context: OpenClawPluginToolContext = {
    senderIsOwner: true,
    requesterSenderId: "fixture-owner",
    messageChannel: "telegram",
    agentAccountId: "fixture",
    agentId: "main",
    sessionKey: "agent:main:fixture",
    sessionId: "fixture-session",
    activeProjectKeys: ["fixture-project"],
    workspaceDir: "/fixture/project",
    sandboxed: true,
  };
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope: "session",
          workspaceAccess: "rw",
          docker: { network: "none", readOnlyRoot: true },
        },
      },
    },
  };
  const source = {
    spawnContext: {
      agentSessionKey: "agent:main:fixture",
      expectedParentSessionId: "fixture-session",
      inheritedToolDenylist: ["message", "exec"],
      inheritedToolPolicySource: "sender" as const,
      requesterToolDenylist: ["browser"],
      sessionPermissionPolicy: { mode: "workspace" as const, root: "/fixture/project" },
    },
    workspaceDir: "/fixture/project",
    getConfig: () => config,
    creatorToolAllowlist: ["sessions_spawn", "read", "write", "exec"],
    creatorToolAllowlistCaptureRef: {
      value: { version: 1 as const, source: "final-executable-surface" as const },
    },
  };
  const assertInvocationCurrent = vi.fn();
  const assertToolAllowed = vi.fn();
  caller.mockReturnValue({
    agentId: "main",
    sessionKey: "agent:main:fixture",
    assertToolAllowed,
    gatewayContextResolver: () => ({}),
  });
  bindPluginScopedTaskSource(context, source);
  const capability = createPluginToolScopedTasks(
    context,
    context,
    assertInvocationCurrent,
    "fixture-plugin",
  )!;
  return { context, config, source, assertInvocationCurrent, assertToolAllowed, capability };
}

describe("caller-bound scoped task preflight", () => {
  it("prepares exact correlation with synthetic caller policy without dispatching", async () => {
    const f = fixture();
    spawn.mockClear();
    const prepared = await f.capability.prepare(request);
    expect(prepared.receipt).toMatchObject({
      contract: "openclaw.scoped-tasks.v1",
      runId: expect.stringMatching(/^plugin-task:/),
      sessionKey: expect.stringMatching(/^agent:main:subagent:plugin-/),
    });
    expect(f.assertToolAllowed.mock.calls.map(([name]) => name)).toEqual([
      "sessions_spawn",
      "read",
      "write",
    ]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("dispatches once through native spawn with host-only ownership and narrow tools", async () => {
    const f = fixture();
    const prepared = await f.capability.prepare(request);
    spawn.mockResolvedValue({
      status: "accepted",
      runId: prepared.receipt.runId,
      childSessionKey: prepared.receipt.sessionKey,
    });
    const input = {
      sessionKey: prepared.receipt.sessionKey,
      message: "Write a harmless fixture",
      timeoutSeconds: 30,
      promptMode: "minimal" as const,
      deliver: false as const,
      idempotencyKey: request.intent,
    };
    expect(await prepared.run(input)).toEqual({
      runId: prepared.receipt.runId,
      sessionKey: prepared.receipt.sessionKey,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox: "require",
        cleanup: "keep",
        expectsCompletionMessage: false,
      }),
      expect.objectContaining({
        inheritedToolAllowlist: ["read", "write"],
        agentSessionKey: "agent:main:fixture",
        inheritedToolDenylist: ["message", "exec"],
        inheritedToolPolicySource: "sender",
        requesterToolDenylist: ["browser"],
      }),
    );
    await expect(prepared.run(input)).rejects.toThrow("already consumed");
  });

  it("rejects exec and a stale prepared closure before native dispatch", async () => {
    const f = fixture();
    await expect(
      f.capability.prepare({ ...request, spec: { ...request.spec, tools: ["exec"] } }),
    ).rejects.toThrow("owned process settlement");
    const prepared = await f.capability.prepare(request);
    f.context.senderIsOwner = false;
    await expect(
      prepared.run({
        sessionKey: prepared.receipt.sessionKey,
        message: "x",
        timeoutSeconds: 30,
        promptMode: "minimal",
        deliver: false,
        idempotencyKey: request.intent,
      }),
    ).rejects.toThrow("identity changed");
  });

  it("refuses a caller permission root narrower than the selected project", async () => {
    const f = fixture();
    f.source.spawnContext.sessionPermissionPolicy.root = "/fixture/project/narrow";
    await expect(f.capability.prepare(request)).rejects.toThrow("current project permission root");
  });

  it("preserves unset caller permissions while rejecting a narrower configured filesystem root", async () => {
    const f = fixture();
    Reflect.deleteProperty(f.source.spawnContext, "sessionPermissionPolicy");
    const prepared = await f.capability.prepare(request);
    spawn.mockResolvedValueOnce({
      status: "accepted",
      runId: prepared.receipt.runId,
      childSessionKey: prepared.receipt.sessionKey,
    });
    await prepared.run({
      sessionKey: prepared.receipt.sessionKey,
      message: "file task",
      timeoutSeconds: 30,
      promptMode: "minimal",
      deliver: false,
      idempotencyKey: request.intent,
    });
    expect(spawn.mock.calls.at(-1)?.[1].sessionPermissionPolicy).toBeUndefined();
    bindPluginScopedTaskSource(f.context, {
      ...f.source,
      fsPolicy: { workspaceOnly: true, root: "/fixture/project/narrow" },
    });
    const restricted = createPluginToolScopedTasks(
      f.context,
      f.context,
      f.assertInvocationCurrent,
      "fixture-plugin",
    )!;
    await expect(restricted.prepare(request)).rejects.toThrow("current project permission root");
  });

  it("rejects launch changes and joins one concurrent native dispatch", async () => {
    const f = fixture();
    const prepared = await f.capability.prepare(request);
    const input = {
      sessionKey: prepared.receipt.sessionKey,
      message: "read fixture",
      timeoutSeconds: 30,
      promptMode: "minimal" as const,
      deliver: false as const,
      idempotencyKey: request.intent,
    };
    spawn.mockClear();
    await expect(
      prepared.run({ ...input, sessionKey: "agent:other:subagent:foreign" }),
    ).rejects.toThrow("differs");
    await expect(prepared.run({ ...input, timeoutSeconds: 31 })).rejects.toThrow("differs");
    expect(spawn).not.toHaveBeenCalled();
    let settle!: (value: unknown) => void;
    spawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    let joined = false;
    const admission = prepared.run(input).then((value) => {
      joined = true;
      return value;
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(joined).toBe(false);
    await expect(prepared.run(input)).rejects.toThrow("already consumed");
    settle({
      status: "accepted",
      runId: prepared.receipt.runId,
      childSessionKey: prepared.receipt.sessionKey,
    });
    await expect(admission).resolves.toEqual({
      runId: prepared.receipt.runId,
      sessionKey: prepared.receipt.sessionKey,
    });
  });

  it.each(["sessions_spawn", "read", "write"])(
    "cannot delegate a tool absent from the final caller surface: %s",
    async (tool) => {
      const f = fixture();
      f.source.creatorToolAllowlist = f.source.creatorToolAllowlist.filter((name) => name !== tool);
      await expect(f.capability.prepare(request)).rejects.toThrow(
        `requires permitted caller tool ${tool}`,
      );
    },
  );

  it("requires completed capture and respects the current native caller permission check", async () => {
    const f = fixture();
    delete (f.source.creatorToolAllowlistCaptureRef as { value?: unknown }).value;
    await expect(f.capability.prepare(request)).rejects.toThrow("capture is incomplete");
    f.source.creatorToolAllowlistCaptureRef.value = {
      version: 1,
      source: "final-executable-surface",
    };
    f.assertToolAllowed.mockImplementation((name) => {
      if (name === "write") {
        throw new Error("write revoked");
      }
    });
    await expect(f.capability.prepare(request)).rejects.toThrow("write revoked");
  });

  it.each(["agent", "session", "local"])(
    "refuses another or missing current native caller (%s)",
    async (change) => {
      const f = fixture();
      caller.mockReturnValue({
        agentId: change === "agent" ? "other" : "main",
        sessionKey: change === "session" ? "other" : "agent:main:fixture",
        assertToolAllowed: f.assertToolAllowed,
        gatewayContextResolver: () => (change === "local" ? undefined : {}),
      });
      await expect(f.capability.prepare(request)).rejects.toThrow(
        "current local native tool caller",
      );
    },
  );

  it("rejects stale source authority, cancellation and context identity changes", async () => {
    const f = fixture();
    f.assertInvocationCurrent.mockImplementationOnce(() => {
      throw new Error("closed invocation");
    });
    await expect(f.capability.prepare(request)).rejects.toThrow("closed invocation");
    await expect(
      f.capability.prepare(request, { signal: AbortSignal.abort(new Error("cancelled")) }),
    ).rejects.toThrow("cancelled");
    f.context.activeProjectKeys = ["other-project"];
    await expect(f.capability.prepare(request)).rejects.toThrow("identity changed");
  });

  it.each(["backend", "shared", "host", "workspace", "readonly"])(
    "refuses unsupported isolation (%s)",
    async (change) => {
      const f = fixture(),
        sandbox = f.config.agents!.defaults!.sandbox!;
      if (change === "backend") {
        sandbox.backend = "ssh";
      }
      if (change === "shared") {
        sandbox.scope = "shared";
      }
      if (change === "host") {
        f.context.sandboxed = false;
      }
      if (change === "workspace") {
        f.context.workspaceDir = "/outside";
      }
      if (change === "readonly") {
        sandbox.workspaceAccess = "ro";
      }
      await expect(f.capability.prepare(request)).rejects.toThrow("session Docker sandbox");
    },
  );

  it("does not construct a capability from unbound or unidentified contexts", () => {
    const f = fixture();
    expect(
      createPluginToolScopedTasks({ ...f.context }, f.context, f.assertInvocationCurrent),
    ).toBeUndefined();
    f.context.senderIsOwner = false;
    expect(
      createPluginToolScopedTasks(f.context, f.context, f.assertInvocationCurrent),
    ).toBeUndefined();
  });

  it.each([
    { spec: { ...request.spec, role: "reviewer", tools: ["write"] } },
    { spec: { ...request.spec, tools: ["sessions_spawn"] } },
    { spec: { ...request.spec, tools: ["read", "read"] } },
    { spec: { ...request.spec, maxToolCalls: 0 } },
    { spec: { ...request.spec, timeoutSeconds: 301 } },
    { spec: { ...request.spec, owner: "other" } },
    { workspace: "/outside" },
    { network: "host" },
    { agentId: "other" },
  ])("rejects widened or malformed request %#", async (patch) => {
    const f = fixture();
    // Exercise the runtime boundary independently of the source-level SDK types.
    await expect(
      f.capability.prepare({ ...request, ...patch } as ScopedTaskPreparationRequest),
    ).rejects.toThrow(/Invalid scoped task|require the current project/);
  });
});

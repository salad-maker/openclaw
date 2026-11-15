import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { createSessionCompoundWorkerFixture } from "../config/sessions/session-compound-worker.test-support.js";
import {
  projectPublicSessionEntry,
  projectPublicSessionEntryPatch,
} from "../config/sessions/session-entry-projection.js";
import type { PluginScopedTaskExecution } from "../config/sessions/types.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { applyCodeModeCatalog, runCodeModeScriptHeadless } from "./code-mode.js";
import {
  createHeadlessCodeModeHarness,
  createCodeModeHarness,
  runUntilCompleted,
  resetCodeModeTestState,
} from "./code-mode.test-support.js";
import { assertSandboxedDelegatedChildNotCli } from "./command/attempt-sandbox-cli-admission.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import { resolvePreparedSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import { resolveScopedTaskSandboxConfig } from "./sandbox/scoped-task-workspace.js";
import { runWithScopedTaskExecution } from "./scoped-task-execution.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";

// Native SQLite/worker mutation and actual source-tool budget wrappers; no model.
vi.mock("../config/sessions/session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
vi.mock("../config/sessions/session-history-eviction.js", () => ({
  kickSessionHistoryDiskBudgetMaintenance() {},
}));
const descriptor: PluginScopedTaskExecution = {
  version: 1,
  intentSha256: "fixture-intent",
  scopeSha256: "fixture-scope",
  requestSha256: "fixture-request",
  runId: "fixture-run",
  maxToolCalls: 2,
  timeoutSeconds: 30,
  tools: ["read", "write"],
};
afterEach(async () => {
  vi.useRealTimers();
  await resetCodeModeTestState();
});
async function fixture(task = descriptor) {
  const f = createSessionCompoundWorkerFixture();
  f.scope.sessionKey += "-scoped";
  replaceSessionEntrySync(f.scope, {
    sessionId: f.scope.sessionId,
    updatedAt: 1,
    sandbox: "required",
    spawnedBy: "agent:main:parent",
    spawnedWorkspaceDir: "/fixture/project",
    sessionRoot: "/fixture/project",
  });
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          backend: "docker",
          scope: "session",
          workspaceAccess: "rw",
          docker: { network: "none", readOnlyRoot: true },
        },
      },
    },
  };
  await patchSessionEntryCore(f.scope, () => ({
    pluginOwnerId: "fixture-plugin",
    pluginScopedTask: task,
  }));
  const controller = new AbortController();
  const params = {
    workspaceDir: "/fixture/project",
    config,
    getConfig: () => config,
    entry: f.read(),
    scope: f.scope,
    sessionId: f.scope.sessionId,
    runId: task.runId,
    signal: controller.signal,
    abort: (reason: Error) => controller.abort(reason),
    assertCurrent: vi.fn(),
    acp: false,
    onClaimed: vi.fn(),
  };
  return { ...f, params, controller };
}

it("claims a native task once and shares its budget across sequential attempts and parallel tool executions", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture();
    const source = vi.fn(async () => ({ content: [], details: {} }));
    await expect(
      runWithScopedTaskExecution(f.params, async () => {
        const first = wrapToolWithBeforeToolCallHook({
          ...createStubTool("read"),
          execute: source,
        });
        await first.execute("first-attempt", {});
        // A fallback builds new tools in the same command budget, not a new budget.
        const next = wrapToolWithBeforeToolCallHook({
          ...createStubTool("write"),
          execute: source,
        });
        await Promise.allSettled([next.execute("second", {}), next.execute("overflow", {})]);
      }),
    ).rejects.toThrow("budget exhausted");
    expect(source).toHaveBeenCalledTimes(2);
    expect(f.read()?.pluginScopedTask?.executionStartedAt).toBeTypeOf("number");
    await expect(
      runWithScopedTaskExecution(
        { ...f.params, signal: new AbortController().signal },
        async () => {
          throw new Error("replayed");
        },
      ),
    ).rejects.toThrow(/already claimed/);
  });
});

it("concurrent command admissions cannot claim the same persisted intent twice", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture(),
      work = vi.fn(async () => "result");
    const result = await Promise.allSettled([
      runWithScopedTaskExecution(f.params, work),
      runWithScopedTaskExecution(f.params, work),
    ]);
    expect(work).toHaveBeenCalledTimes(1);
    expect(result.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });
});

it("retained tools close after completion and a fresh command cannot refresh the budget", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture(),
      source = vi.fn(async () => ({ content: [], details: {} }));
    let retained: ReturnType<typeof wrapToolWithBeforeToolCallHook> | undefined;
    await runWithScopedTaskExecution(f.params, async () => {
      retained = wrapToolWithBeforeToolCallHook({ ...createStubTool("read"), execute: source });
      await retained.execute("first", {});
    });
    await expect(retained!.execute("late", {})).rejects.toThrow("no longer active");
    await expect(
      runWithScopedTaskExecution(
        { ...f.params, entry: f.read(), runId: "new-run", signal: new AbortController().signal },
        async () => undefined,
      ),
    ).rejects.toThrow(/already claimed/);
    expect(source).toHaveBeenCalledTimes(1);
  });
});

it("failure after persisted admission is never replayed, including with a freshly read row", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture();
    await expect(
      runWithScopedTaskExecution(f.params, async () => {
        throw new Error("provider interrupted");
      }),
    ).rejects.toThrow("provider interrupted");
    await expect(
      runWithScopedTaskExecution({ ...f.params, entry: f.read() }, async () => {
        throw new Error("replay");
      }),
    ).rejects.toThrow(/already claimed/);
  });
});

it.each(["wrong-session", "wrong-run", "missing-owner", "acp", "cancelled"])(
  "refuses unsupported admission before tools (%s)",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await fixture(),
        work = vi.fn(async () => undefined);
      if (mode === "wrong-session") {
        f.params.sessionId = "foreign";
      }
      if (mode === "wrong-run") {
        f.params.runId = "foreign";
      }
      if (mode === "missing-owner") {
        f.params.entry!.pluginOwnerId = undefined;
      }
      if (mode === "acp") {
        f.params.acp = true;
      }
      if (mode === "cancelled") {
        f.controller.abort(new Error("cancelled"));
      }
      await expect(runWithScopedTaskExecution(f.params, work)).rejects.toThrow();
      expect(work).not.toHaveBeenCalled();
      expect(f.read()?.pluginScopedTask?.executionStartedAt).toBeUndefined();
    });
  },
);

it.each([
  { maxToolCalls: 33 },
  { maxToolCalls: 0 },
  { tools: ["exec"] },
  { tools: ["sessions_spawn"] },
])("rejects invalid persisted budget or non-file tools %#", async (patch) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture({ ...descriptor, ...patch }),
      work = vi.fn(async () => undefined);
    await expect(runWithScopedTaskExecution(f.params, work)).rejects.toThrow(
      /budget is unavailable/,
    );
    expect(work).not.toHaveBeenCalled();
  });
});

it("keeps task ownership and execution claim private in public entry and patch projections", () => {
  const entry = {
    sessionId: "fixture",
    updatedAt: 1,
    pluginOwnerId: "fixture-plugin",
    pluginScopedTask: descriptor,
  };
  expect(projectPublicSessionEntry(entry)).not.toHaveProperty("pluginScopedTask");
  expect(
    projectPublicSessionEntryPatch({ pluginScopedTask: { ...descriptor, executionStartedAt: 1 } }),
  ).not.toHaveProperty("pluginScopedTask");
});

it("reopened native storage retains a spent claim and rejects both identical and new run IDs", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture();
    await runWithScopedTaskExecution(f.params, async () => "done");
    await closeOpenClawAgentDatabaseByPathAsync(f.database.path);
    const reopened = openOpenClawAgentDatabase({ agentId: "main" });
    const entry = readExactSessionEntryRow(reopened, f.scope.sessionKey)?.entry;
    expect(entry?.pluginScopedTask?.executionStartedAt).toBeTypeOf("number");
    for (const runId of [descriptor.runId, "another-run"]) {
      const work = vi.fn(async () => undefined);
      await expect(runWithScopedTaskExecution({ ...f.params, entry, runId }, work)).rejects.toThrow(
        /already claimed/,
      );
      expect(work).not.toHaveBeenCalled();
    }
  });
});

it("charges real Code Mode nested file calls against the native command budget", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture(),
      source = vi.fn(async () => ({ content: [], details: {} }));
    await expect(
      runWithScopedTaskExecution(f.params, async () => {
        const read = wrapToolWithBeforeToolCallHook({ ...createStubTool("read"), execute: source });
        const write = wrapToolWithBeforeToolCallHook({
          ...createStubTool("write"),
          execute: source,
        });
        await runCodeModeScriptHeadless({
          ctx: createHeadlessCodeModeHarness([read, write]),
          code: "await read({}); await Promise.allSettled([write({}), read({})]); return true;",
        });
      }),
    ).rejects.toThrow("budget exhausted");
    expect(source).toHaveBeenCalledTimes(2);
  });
});

it("rejects sandbox configuration drift before claiming work and at the final tool source", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture(),
      work = vi.fn(async () => undefined);
    let current: OpenClawConfig = {};
    f.params.getConfig = () => current;
    await expect(runWithScopedTaskExecution(f.params, work)).rejects.toThrow(
      /session Docker sandbox/,
    );
    expect(work).not.toHaveBeenCalled();
    expect(f.read()?.pluginScopedTask?.executionStartedAt).toBeUndefined();
    current = f.params.config;
    const source = vi.fn(async () => ({ content: [], details: {} }));
    await expect(
      runWithScopedTaskExecution(f.params, async () => {
        const tool = wrapToolWithBeforeToolCallHook({ ...createStubTool("read"), execute: source });
        current = {};
        await tool.execute("drift", {});
      }),
    ).rejects.toThrow(/session Docker sandbox/);
    expect(source).not.toHaveBeenCalled();
  });
});

it("a fallback cannot reset the persisted task deadline before a file effect", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture({ ...descriptor, timeoutSeconds: 1, maxToolCalls: 4 });
    const source = vi.fn(async () => ({ content: [], details: {} }));
    await expect(
      runWithScopedTaskExecution(f.params, async () => {
        const first = wrapToolWithBeforeToolCallHook({
          ...createStubTool("read"),
          execute: source,
        });
        await first.execute("first-attempt", {});
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(f.read()!.pluginScopedTask!.executionStartedAt! + 1001);
        const fallback = wrapToolWithBeforeToolCallHook({
          ...createStubTool("write"),
          execute: source,
        });
        await fallback.execute("fallback-after-deadline", {});
      }),
    ).rejects.toThrow("deadline");
    expect(f.controller.signal.aborted).toBe(true);
    expect(source).toHaveBeenCalledTimes(1);
  });
});

it("requests abort at the whole-task deadline but joins an abort-ignoring response and rejects late success", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture({ ...descriptor, timeoutSeconds: 1 });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      f.controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    let settled = false;
    const pending = runWithScopedTaskExecution(f.params, async () => {
      await held;
      return "late success";
    });
    const outcome = pending.then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await aborted;
      expect(settled).toBe(false);
      expect(f.controller.signal.reason.message).toContain("deadline");
    } finally {
      release();
    }
    expect(await outcome).toEqual({
      error: expect.objectContaining({ message: expect.stringContaining("deadline") }),
    });
    await expect(
      runWithScopedTaskExecution(
        { ...f.params, entry: f.read(), signal: new AbortController().signal },
        async () => "replay",
      ),
    ).rejects.toThrow("already claimed");
  });
});

it("the native attempt seam rejects host CLI fallback for a claimed sandboxed child", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture();
    await expect(
      runWithScopedTaskExecution(f.params, async () => {
        assertSandboxedDelegatedChildNotCli({
          useCliExecution: true,
          cliExecutionProvider: "fixture-cli",
          cfg: f.params.config,
          sessionKey: f.scope.sessionKey,
          sessionAgentId: "main",
          sessionEntry: f.read(),
        });
      }),
    ).rejects.toThrow("cannot honor the sandbox");
  });
});

it("grants only the claimed child an effective writable project sandbox while narrowing parent configuration", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture();
    const docker = f.params.config.agents!.defaults!.sandbox!.docker!;
    docker.network = "fixture-internal";
    docker.binds = ["/parent-only:/parent-only"];
    await runWithScopedTaskExecution(f.params, async () => {
      const runtime = resolvePreparedSandboxRuntimeStatus({
        cfg: f.params.config,
        agentId: "main",
        sessionKey: f.scope.sessionKey,
        preparedSessionEntry: f.read()!,
      });
      expect(runtime.workspaceAccess).toBe("rw");
      const effective = resolveScopedTaskSandboxConfig({
        agentId: "main",
        sessionKey: f.scope.sessionKey,
        workspaceDir: f.params.workspaceDir,
        configured: resolveSandboxConfigForAgent(f.params.config, "main"),
      });
      expect(effective?.docker).toMatchObject({ network: "none", binds: [], readOnlyRoot: true });
      expect(
        resolveScopedTaskSandboxConfig({
          agentId: "main",
          sessionKey: "agent:main:other",
          workspaceDir: f.params.workspaceDir,
          configured: resolveSandboxConfigForAgent(f.params.config, "main"),
        }),
      ).toBeUndefined();
    });
    expect(docker).toMatchObject({
      network: "fixture-internal",
      binds: ["/parent-only:/parent-only"],
    });
    expect(
      resolveScopedTaskSandboxConfig({
        agentId: "main",
        sessionKey: f.scope.sessionKey,
        workspaceDir: f.params.workspaceDir,
        configured: resolveSandboxConfigForAgent(f.params.config, "main"),
      }),
    ).toBeUndefined();
  });
});

it("keeps a read-only task's actual native workspace read-only", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture({ ...descriptor, tools: ["read"] });
    await runWithScopedTaskExecution(f.params, async () => {
      const runtime = resolvePreparedSandboxRuntimeStatus({
        cfg: f.params.config,
        agentId: "main",
        sessionKey: f.scope.sessionKey,
        preparedSessionEntry: f.read()!,
      });
      expect(runtime.workspaceAccess).toBe("ro");
      const effective = resolveScopedTaskSandboxConfig({
        agentId: "main",
        sessionKey: f.scope.sessionKey,
        workspaceDir: f.params.workspaceDir,
        configured: resolveSandboxConfigForAgent(f.params.config, "main"),
      });
      expect(effective?.workspaceAccess).toBe("ro");
    });
  });
});

it("permits branded Code Mode controls but counts their nested exact source tools", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await fixture({ ...descriptor, tools: ["read"], maxToolCalls: 1 });
    const source = vi.fn(async () => ({ content: [], details: {} }));
    await runWithScopedTaskExecution(f.params, async () => {
      const harness = createCodeModeHarness();
      const controls = harness.tools.map((entry) => wrapToolWithBeforeToolCallHook(entry));
      const read = wrapToolWithBeforeToolCallHook({ ...createStubTool("read"), execute: source });
      applyCodeModeCatalog({ ...harness.ctx, tools: [...controls, read] });
      const result = await runUntilCompleted({
        execTool: controls[0]!,
        waitTool: controls[1]!,
        code: "await read({}); return true;",
      });
      expect(result.status).toBe("completed");
      expect(result.value).toBe(true);
    });
    expect(source).toHaveBeenCalledTimes(1);
  });
});

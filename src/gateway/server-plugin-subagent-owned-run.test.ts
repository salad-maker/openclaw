import { afterEach, describe, expect, test, vi } from "vitest";
import { retireSubagentGatewayBinding } from "../agents/subagents/registry/subagent-registry-execution-cleanup.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { persistRegistryFixture } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
  bindGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runWithChatAbortExecution } from "./chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry } from "./chat-abort.types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { assertPluginOwnedRun, projectPluginOwnedRun } from "./server-plugin-subagent-owned-run.js";
import { createGatewaySubagentRuntime } from "./server-plugin-subagent-runtime.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";

const sessionKey = "agent:main:subagent:owned";
afterEach(() => vi.unstubAllEnvs());
const session: SessionEntry = {
  sessionId: "physical-session",
  lifecycleRevision: "revision-1",
  updatedAt: 1,
  pluginOwnerId: "coordination",
};
function record(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: sessionKey,
    childSessionIdentity: { sessionId: session.sessionId, lifecycleRevision: "revision-1" },
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "private prompt must not be projected",
    cleanup: "keep",
    createdAt: 10,
    execution: { status: "running", startedAt: 11 },
    completion: { required: false },
    delivery: { status: "not_required" },
    ...overrides,
  };
}

describe("plugin-owned native run evidence", () => {
  test("SDK reads durable rows and rejects foreign plugin and read-only cancellation", async () => {
    vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      replaceSessionEntrySync({ agentId: "main", sessionKey }, session);
      persistRegistryFixture(new Map([["run-1", record()]]));
      let aborted = 0;
      const context = createContext(
        [
          ["sessions.get", "operator.read", "sessions", async () => {}],
          [
            "sessions.abort",
            "operator.write",
            "sessions",
            async ({ params, respond }) => {
              expect(params).toEqual({ key: sessionKey, runId: "run-1" });
              aborted++;
              respond(true, { status: "aborted", abortedRunId: "run-1" });
            },
          ],
        ],
        () => cfg,
      );
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      bindSessionRowProjection(context, () => projection);
      const lifetime = new AbortController();
      const runtime = createGatewaySubagentRuntime(() => context, {}, lifetime.signal);
      const invoke = async <T>(pluginId: string, scopes: string[], run: () => Promise<T>) =>
        withPluginRuntimeGatewayRequestScope(
          {
            client: createSyntheticPluginRuntimeClient({
              scopes,
              operatorRoleActor: { kind: "system" },
            }),
            context,
            isWebchatConnect: () => false,
          },
          () => withPluginRuntimePluginScope({ pluginId }, run),
        );
      try {
        expect(
          await invoke("coordination", ["operator.read"], () =>
            runtime.getRun!({ sessionKey, runId: "run-1" }),
          ),
        ).toMatchObject({ status: "running" });
        await expect(
          invoke("foreign", ["operator.read"], () =>
            runtime.getRun!({ sessionKey, runId: "run-1" }),
          ),
        ).rejects.toThrow("unavailable");
        await expect(
          invoke("coordination", ["operator.read"], () =>
            runtime.cancelRun!({ sessionKey, runId: "run-1" }),
          ),
        ).rejects.toThrow();
        expect(aborted).toBe(0);
        expect(
          await invoke("coordination", ["operator.read", "operator.write"], () =>
            runtime.cancelRun!({ sessionKey, runId: "run-1" }),
          ),
        ).toMatchObject({ status: "acknowledged" });
        expect(aborted).toBe(1);
        persistRegistryFixture(
          new Map([
            [
              "run-1",
              record({
                execution: { status: "terminal", endedAt: 20, outcome: { status: "ok" } },
                endedReason: "subagent-complete",
                completion: { required: false, resultText: "retained result", capturedAt: 21 },
              }),
            ],
          ]),
        );
        const laterRuntime = createGatewaySubagentRuntime(() => context);
        expect(
          await invoke("coordination", ["operator.read"], () =>
            laterRuntime.getRun!({ sessionKey, runId: "run-1" }),
          ),
        ).toMatchObject({
          status: "terminal",
          ownedWorkPending: false,
          outcome: "ok",
          result: { text: "retained result", capturedAt: 21, source: "native-subagent-completion" },
        });
        // Native cancellation publishes its terminal row before raw disposal can finish.
        const cancelled = record({
          execution: { status: "terminal", endedAt: 20, outcome: { status: "error" } },
          endedReason: "subagent-killed",
        });
        subagentRuns.set(cancelled.runId, cancelled);
        persistRegistryFixture(new Map([[cancelled.runId, cancelled]]));
        const raw: ChatAbortControllerEntry = {
          kind: "agent",
          controller: new AbortController(),
          sessionId: session.sessionId,
          sessionKey,
          startedAtMs: 10,
          expiresAtMs: Number.MAX_SAFE_INTEGER,
        };
        context.chatAbortControllers = new Map([[cancelled.runId, raw]]);
        bindGatewayContextResolver(cancelled, () => context);
        const tail = createDeferredCore();
        const completion = runWithChatAbortExecution(
          raw,
          () => tail.promise,
          () => {},
        );
        raw.controller.abort(); // The controlled provider ignores abort until its tail is released.
        try {
          const observe = () =>
            invoke("coordination", ["operator.read"], () =>
              laterRuntime.getRun!({ sessionKey, runId: cancelled.runId }),
            );
          expect(raw.executionSettlement?.cleanupSettled).toBe(false);
          expect(await observe()).toMatchObject({
            status: "terminal",
            outcome: "cancelled",
            ownedWorkPending: true,
          });
          expect(
            await invoke("coordination", ["operator.write"], () =>
              laterRuntime.cancelRun!({ sessionKey, runId: cancelled.runId }),
            ),
          ).toMatchObject({ status: "acknowledged" });
          expect(aborted).toBe(2);
          retireSubagentGatewayBinding(cancelled);
          expect(await observe()).toMatchObject({ ownedWorkPending: true });
          tail.resolve();
          await completion;
          expect(raw.executionSettlement?.cleanupSettled).toBe(true);
          expect(await observe()).toMatchObject({
            status: "terminal",
            outcome: "cancelled",
            ownedWorkPending: false,
          });
        } finally {
          tail.resolve();
          await completion;
          subagentRuns.delete(cancelled.runId);
        }
        lifetime.abort(new Error("Plugin runtime retired"));
        await expect(
          invoke("coordination", ["operator.write"], () =>
            runtime.getRun!({ sessionKey, runId: "run-1" }),
          ),
        ).rejects.toThrow("retired");
        await expect(
          invoke("coordination", ["operator.write"], () =>
            runtime.cancelRun!({ sessionKey, runId: "run-1" }),
          ),
        ).rejects.toThrow("retired");
        expect(aborted).toBe(2);
      } finally {
        projection.dispose();
      }
    });
  });
  test("requires plugin ownership and exact immutable session/run identity", () => {
    expect(() =>
      assertPluginOwnedRun("coordination", sessionKey, "run-1", session, record()),
    ).not.toThrow();
    for (const candidate of [
      undefined,
      { ...session, pluginOwnerId: "another-plugin" },
      { ...session, pluginOwnerId: undefined },
      { ...session, lifecycleRevision: undefined },
      { ...session, lifecycleRevision: "reset-session" },
      { ...session, sessionId: "new-physical-session" },
    ]) {
      expect(() =>
        assertPluginOwnedRun("coordination", sessionKey, "run-1", candidate, record()),
      ).toThrow("unavailable");
    }
    for (const candidate of [
      record({ runId: "another-run" }),
      record({ childSessionKey: "agent:other:subagent:owned" }),
      record({ childSessionIdentity: undefined }),
      record({ childSessionIdentity: { sessionId: session.sessionId } }),
    ]) {
      expect(() =>
        assertPluginOwnedRun("coordination", sessionKey, "run-1", session, candidate),
      ).toThrow("unavailable");
    }
  });

  test("missing native evidence stays unknown and idle does not imply success", () => {
    expect(projectPluginOwnedRun(sessionKey, "run-1", undefined)).toEqual({
      sessionKey,
      runId: "run-1",
      status: "unknown",
      ownedWorkPending: true,
    });
    expect(projectPluginOwnedRun(sessionKey, "run-1", record())).not.toHaveProperty("outcome");
    expect(
      projectPluginOwnedRun(sessionKey, "run-1", record({ execution: { status: "interrupted" } })),
    ).toMatchObject({ status: "interrupted" });
  });

  test("returns exact retained terminal result and capture provenance only", () => {
    const run = record({
      execution: { status: "terminal", startedAt: 11, endedAt: 20, outcome: { status: "ok" } },
      endedReason: "subagent-complete",
      completion: { required: false, resultText: "verified text", capturedAt: 21 },
    });
    const recovered = projectPluginOwnedRun(sessionKey, "run-1", structuredClone(run));
    expect(recovered).toEqual({
      sessionKey,
      runId: "run-1",
      status: "terminal",
      ownedWorkPending: true,
      createdAt: 10,
      startedAt: 11,
      endedAt: 20,
      outcome: "ok",
      error: undefined,
      result: { text: "verified text", capturedAt: 21, source: "native-subagent-completion" },
    });
    expect(recovered).not.toHaveProperty("task");
  });

  test("natural completion after kill intent is not cancellation confirmation", () => {
    const run = record({
      execution: { status: "terminal", endedAt: 20, outcome: { status: "ok" } },
      endedReason: "subagent-complete",
    });
    expect(projectPluginOwnedRun(sessionKey, "run-1", run).outcome).toBe("ok");
    expect(
      projectPluginOwnedRun(sessionKey, "run-1", { ...run, endedReason: "subagent-killed" })
        .outcome,
    ).toBe("cancelled");
  });

  test("does not invent result evidence from fallback text or incomplete capture", () => {
    for (const completion of [
      { required: false, fallbackResultText: "uncertain", fallbackCapturedAt: 21 },
      { required: false, resultText: "uncaptured" },
    ]) {
      expect(
        projectPluginOwnedRun(
          sessionKey,
          "run-1",
          record({ execution: { status: "terminal" }, completion }),
        ),
      ).not.toHaveProperty("result");
    }
  });
});

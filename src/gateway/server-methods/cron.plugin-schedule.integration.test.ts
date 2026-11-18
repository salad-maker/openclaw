import { expect, it, vi } from "vitest";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { withPreparedEmbeddedGatewayTools } from "../../agents/embedded-agent-runner/run/attempt-gateway-tools.js";
import { captureFinalEffectiveCronCreatorToolAllowlist } from "../../agents/tools/cron-tool.js";
import type {
  CronCreatorToolAllowlistEntry,
  CronToolsAllowCaptureRef,
} from "../../agents/tools/cron-tool.types.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { toPublicCronJob } from "../../cron/public-job.js";
import {
  bindPluginScheduleSource,
  createPluginToolSchedules,
} from "../../plugins/tool-schedules.js";
import type { OpenClawPluginToolContext } from "../../plugins/tool-types.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import {
  SESSION,
  SESSION_ID,
  cfg,
  cron,
  createCronFixture,
  inRun,
  installRequesterCronAuthorityTestHooks,
} from "./requester-cron-authority.test-support.js";

installRequesterCronAuthorityTestHooks();

it("composes real creator admission, native cron persistence, exact history and scoped cancellation without inference", async () => {
  await persistAuthProfileBatch({
    profiles: [
      {
        profileId: "openai:plugin-schedule-fixture",
        credential: {
          type: "api_key",
          provider: "openai",
          key: "synthetic-never-sent-schedule-key",
        },
      },
    ],
  });
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let interrupted = false;
  let startedIgnored!: () => void;
  let releaseIgnored!: () => void;
  const ignoredStarted = new Promise<void>((resolve) => {
    startedIgnored = resolve;
  });
  const ignoredRelease = new Promise<void>((resolve) => {
    releaseIgnored = resolve;
  });
  let ignoredAbort = false;
  const fixture = createCronFixture(undefined, cfg, async ({ job, abortSignal }) => {
    if (job.payload.kind === "agentTurn" && job.payload.message === "HOLD") {
      if (!abortSignal) {
        throw new Error("Native worker cancellation signal missing");
      }
      abortSignal.addEventListener(
        "abort",
        () => {
          ignoredAbort = true;
        },
        { once: true },
      );
      startedIgnored();
      await ignoredRelease;
      return { status: "ok", summary: "Late abort-ignoring completion" };
    }
    if (job.payload.kind === "agentTurn" && job.payload.message === "WAIT") {
      if (!abortSignal) {
        throw new Error("Native worker cancellation signal missing");
      }
      started();
      await new Promise<void>((resolve) => {
        const stop = () => {
          interrupted = true;
          resolve();
        };
        if (abortSignal.aborted) {
          stop();
        } else {
          abortSignal.addEventListener("abort", stop, { once: true });
        }
      });
      return {
        status: "error",
        error: "Controlled worker interrupted",
        errorClassification: { kind: "aborted" },
      };
    }
    const sessionId = "plugin-scheduled-fixture-result";
    const base = `agent:main:cron:${job.id}`;
    const sessionKey = `${base}:run:${sessionId}`;
    const scope = { agentId: "main", sessionKey: base, sessionId };
    await upsertSessionEntryCore(scope, {
      sessionId,
      updatedAt: Date.now(),
      lifecycleRevision: "result-incarnation",
    });
    await appendTranscriptMessage(scope, { message: { role: "assistant", content: "OK" } });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId, updatedAt: Date.now(), lifecycleRevision: "result-incarnation" },
    );
    return { status: "ok", summary: "OK", sessionId, sessionKey };
  });
  const gatewayContext = await createHistoryReadContext(fixture.context);
  const runId = "plugin-schedule-creator";
  await inRun(
    runId,
    {
      runId,
      callerOrigin: { kind: "unknown" },
      callerScopedCreation: true,
      managementEntitlement: { source: "channel-owner", isCurrent: () => true },
    },
    async (_identity, admittedRun, creator) => {
      await withPreparedEmbeddedGatewayTools(
        {
          cronCreatorAuthorityCapability: creator,
          agentAccountId: "default",
          admittedRunContext: admittedRun,
          agentId: "main",
          sessionKey: SESSION,
          sessionId: SESSION_ID,
          agentHarnessId: "openclaw",
        },
        async () => {
          const caller = getGatewayToolCallerIdentity();
          if (!caller) {
            throw new Error("No admitted caller");
          }
          await withGatewayToolCallerIdentity(
            { ...caller, gatewayContextResolver: () => gatewayContext },
            async () => {
              const context: OpenClawPluginToolContext = {
                agentId: "main",
                sessionKey: SESSION,
                sessionId: SESSION_ID,
                senderIsOwner: true,
                requesterSenderId: "fixture-owner",
                messageChannel: "telegram",
                agentAccountId: "default",
                activeProjectKeys: ["fixture-project"],
              };
              const tools: CronCreatorToolAllowlistEntry[] = [];
              const capture: CronToolsAllowCaptureRef = {};
              captureFinalEffectiveCronCreatorToolAllowlist(tools, capture, [
                { name: "automations" },
              ]);
              bindPluginScheduleSource(context, {
                agentId: "main",
                agentSessionKey: SESSION,
                agentAccountId: "default",
                runId,
                config: cfg,
                creatorToolAllowlist: tools,
                creatorToolAllowlistCaptureRef: capture,
              });
              const capability = createPluginToolSchedules(
                context,
                context,
                "coordination",
                resolveAdmittedRunActiveAssertion(admittedRun)!,
              );
              expect(capability).toBeDefined();
              const input = {
                intent: "goal-1",
                at: new Date(Date.now() + 60000).toISOString(),
                message: "Say OK",
              };
              const receipt = await capability!.admit(input);
              const stored = (await fixture.read()).find((job) => job.id === receipt.id)!;
              expect(stored.pluginSchedule).toMatchObject({
                pluginId: "coordination",
                intent: "goal-1",
              });
              expect(stored.payload).toMatchObject({ kind: "agentTurn", toolsAllow: [] });
              expect(stored.delivery).toEqual({ mode: "none" });
              expect(toPublicCronJob(stored)).not.toHaveProperty("pluginSchedule");
              expect(await capability!.resolve("goal-1")).toEqual(receipt);
              await expect(capability!.admit(input)).rejects.toThrow();
              expect((await fixture.read()).filter((job) => job.id === receipt.id)).toHaveLength(1);
              const foreign = createPluginToolSchedules(
                context,
                context,
                "other-plugin",
                resolveAdmittedRunActiveAssertion(admittedRun)!,
              );
              await expect(foreign!.cancel(receipt)).rejects.toThrow("ownership");
              await cron.run(receipt.id, "force");
              const evidence = await capability!.inspect(receipt);
              const entries = (
                evidence.runs as {
                  entries: Array<{ runId: string; jobId: string; status: string }>;
                }
              ).entries;
              expect(entries[0]).toMatchObject({ jobId: receipt.id, status: "ok" });
              const history = (await capability!.history(receipt, entries[0]!.runId)) as {
                messages: unknown[];
              };
              expect(history.messages).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ role: "assistant", content: "OK" }),
                ]),
              );
              await expect(capability!.history(receipt, "unrelated-run")).rejects.toThrow();
              expect(await capability!.cancel(receipt)).toEqual({
                cancellation: "confirmed-stopped",
              });
              const controlled = await capability!.admit({
                ...input,
                intent: "controlled-worker",
                message: "WAIT",
              });
              const execution = cron.run(controlled.id, "force");
              await waiting;
              expect(interrupted).toBe(false);
              await capability!.cancel(controlled);
              expect(interrupted).toBe(true);
              await execution;
              const stopped = await capability!.inspect(controlled);
              expect(stopped.stopped).toBe(true);
              expect(
                (stopped.runs as { entries: Array<{ status: string }> }).entries[0]?.status,
              ).toBe("error");
              const ignoring = await capability!.admit({
                ...input,
                intent: "abort-ignoring",
                message: "HOLD",
              });
              const ignoredExecution = cron.run(ignoring.id, "force");
              try {
                await ignoredStarted;
                await capability!.cancel(ignoring);
                await ignoredExecution;
                expect(ignoredAbort).toBe(true);
                expect((await capability!.inspect(ignoring)).stopped).toBe(false);
                expect(await capability!.cancel(ignoring)).toEqual({ cancellation: "requested" });
                releaseIgnored();
                await vi.waitFor(async () =>
                  expect((await capability!.inspect(ignoring)).stopped).toBe(true),
                );
              } finally {
                releaseIgnored();
                await ignoredExecution;
              }
            },
          );
        },
      );
    },
  );
});

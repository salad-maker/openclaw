import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginScheduleDefinition } from "../cron/plugin-schedule-definition.js";
import { trackActiveCronTaskRunSettlement } from "../cron/service/active-run-cancellation.js";
import type { CronStoredJob } from "../cron/types.js";
import { capturePluginScheduleAuthority, pluginScheduleId } from "./plugin-schedule-authority.js";
import { bindPluginScheduleSource, createPluginToolSchedules } from "./tool-schedules.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  caller: vi.fn(),
  inProcess: vi.fn(),
  active: vi.fn(),
  cancel: vi.fn(),
  history: vi.fn(),
}));
vi.mock("../agents/tools/cron-tool.js", () => ({
  createCronTool: () => ({ execute: mocks.execute }),
}));
vi.mock("../agents/tools/gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: mocks.caller,
}));
vi.mock("../agents/tools/gateway.js", () => ({
  shouldUseInProcessGatewayTool: mocks.inProcess,
  callGatewayTool: mocks.history,
}));
vi.mock("../cron/active-jobs.js", () => ({
  isCronJobActive: mocks.active,
  requestActiveCronJobCancellation: mocks.cancel,
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.inProcess.mockReturnValue(true);
  mocks.active.mockReturnValue(false);
});

function fixture() {
  const jobs = new Map<string, CronStoredJob>();
  const context: OpenClawPluginToolContext = {
    senderIsOwner: true,
    requesterSenderId: "owner",
    messageChannel: "telegram",
    agentAccountId: "default",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    activeProjectKeys: ["project"],
  };
  const assertCurrent = vi.fn();
  const options = {
    agentId: "main",
    creatorToolAllowlist: ["automations"],
    creatorToolAllowlistCaptureRef: {
      value: { version: 1 as const, source: "final-executable-surface" as const },
    },
  };
  const gateway = {
    cron: { getJob: (id: string) => jobs.get(id), readJob: async (id: string) => jobs.get(id) },
  };
  mocks.caller.mockReturnValue({
    gatewayContextResolver: () => gateway,
    assertToolAllowed: vi.fn(),
  });
  mocks.execute.mockImplementation(async (_id, input) => {
    const grant = capturePluginScheduleAuthority();
    grant?.assertCurrent();
    if (input.action === "add") {
      if (!grant) {
        throw new Error("No host creation provenance");
      }
      const id = pluginScheduleId(grant.ownership);
      if (jobs.has(id)) {
        throw new Error("Native duplicate id");
      }
      const job: CronStoredJob = {
        ...input.job,
        id,
        state: {},
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };
      job.pluginSchedule = { ...grant.ownership, definition: pluginScheduleDefinition(job) };
      jobs.set(id, job);
      return { details: job };
    }
    const job = jobs.get(input.jobId)!;
    if (input.action === "update") {
      grant?.assertCurrent();
      job.enabled = input.job.enabled;
    }
    return { details: input.action === "runs" ? { entries: [] } : job };
  });
  bindPluginScheduleSource(context, options);
  const capability = createPluginToolSchedules(context, context, "plugin-a", assertCurrent)!;
  const input = {
    intent: "goal-1",
    at: new Date(Date.now() + 60000).toISOString(),
    message: "Say OK",
  };
  return { context, options, jobs, capability, input, assertCurrent };
}

describe("scoped native plugin schedules", () => {
  it("does not confirm settlement while an abort-ignoring native core outlives its active marker", async () => {
    const f = fixture();
    const receipt = await f.capability.admit(f.input);
    let release!: () => void;
    const core = new Promise<void>((resolve) => {
      release = resolve;
    });
    trackActiveCronTaskRunSettlement(core, undefined, "main", receipt.id);
    try {
      expect(await f.capability.cancel(receipt)).toEqual({ cancellation: "requested" });
      expect((await f.capability.inspect(receipt)).stopped).toBe(false);
      release();
      await vi.waitFor(async () =>
        expect((await f.capability.inspect(receipt)).stopped).toBe(true),
      );
    } finally {
      release();
      await core;
    }
  });
  it("uses native tool-free one-shot policy and host-only creation provenance", async () => {
    const f = fixture();
    const receipt = await f.capability.admit(f.input);
    expect(f.jobs.get(receipt.id)).toMatchObject({
      payload: { kind: "agentTurn", toolsAllow: [], timeoutSeconds: 60 },
      delivery: { mode: "none" },
      sessionTarget: "isolated",
      deleteAfterRun: false,
      pluginSchedule: { pluginId: "plugin-a", intent: "goal-1" },
    });
    expect(await f.capability.resolve(f.input.intent)).toEqual(receipt);
    await expect(f.capability.admit(f.input)).rejects.toThrow("duplicate");
    expect(f.jobs.size).toBe(1);
  });
  it("fails closed when the final native automation tool is denied or transport is remote", async () => {
    const f = fixture();
    f.options.creatorToolAllowlist.length = 0;
    await expect(f.capability.admit(f.input)).rejects.toThrow("final permitted");
    expect(mocks.execute).not.toHaveBeenCalled();
    f.options.creatorToolAllowlist.push("automations");
    mocks.inProcess.mockReturnValue(false);
    await expect(f.capability.admit(f.input)).rejects.toThrow("local authenticated");
  });
  it("denies another plugin or project and rejects changed native execution inputs", async () => {
    const f = fixture();
    const receipt = await f.capability.admit(f.input);
    const other = createPluginToolSchedules(f.context, f.context, "plugin-b", f.assertCurrent)!;
    await expect(other.inspect(receipt)).rejects.toThrow("ownership");
    const changed = { ...f.context, activeProjectKeys: ["other-project"] };
    const project = createPluginToolSchedules(f.context, changed, "plugin-a", f.assertCurrent)!;
    await expect(project.inspect(receipt)).rejects.toThrow("ownership");
    const job = f.jobs.get(receipt.id)!;
    if (job.payload.kind !== "agentTurn") {
      throw new Error("wrong fixture");
    }
    job.payload.model = "different/model";
    await expect(f.capability.inspect(receipt)).rejects.toThrow("definition");
  });
  it("keeps active cancellation requested until the native execution actually settles", async () => {
    const f = fixture();
    const receipt = await f.capability.admit(f.input);
    mocks.active.mockReturnValue(true);
    expect(await f.capability.cancel(receipt)).toEqual({ cancellation: "requested" });
    expect(mocks.cancel).toHaveBeenCalledWith(receipt.id, expect.any(String));
    expect(f.jobs.get(receipt.id)?.enabled).toBe(false);
    expect((await f.capability.inspect(receipt)).stopped).toBe(false);
    mocks.active.mockReturnValue(false);
    expect((await f.capability.inspect(receipt)).stopped).toBe(true);
  });
  it("uses exact native run history with the original creator policy and detects revocation", async () => {
    const f = fixture();
    const receipt = await f.capability.admit(f.input);
    mocks.history.mockResolvedValue({ messages: [] });
    await f.capability.history(receipt, "run-1");
    expect(mocks.history).toHaveBeenCalledWith(
      "cron.history",
      {},
      { id: receipt.id, runId: "run-1", limit: 200 },
    );
    f.assertCurrent.mockImplementation(() => {
      throw new Error("revoked");
    });
    await expect(f.capability.inspect(receipt)).rejects.toThrow("revoked");
  });
});

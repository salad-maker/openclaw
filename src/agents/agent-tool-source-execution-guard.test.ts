import { expect, it, vi } from "vitest";
import {
  assertAgentToolExecutionHarness,
  createAgentToolExecutionBudget,
} from "./agent-tool-source-execution-guard.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";

it("admits exactly the budget across parallel source executions", async () => {
  const controller = new AbortController();
  const budget = createAgentToolExecutionBudget({
    maxToolCalls: 2,
    requireNativeHarness: true,
    allowedToolNames: ["read"],
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
  });
  const source = vi.fn(async () => ({ content: [], details: {} }));
  await budget.run(async () => {
    assertAgentToolExecutionHarness(true);
    const tool = wrapToolWithBeforeToolCallHook({ ...createStubTool("read"), execute: source });
    await Promise.allSettled([1, 2, 3].map((id) => tool.execute(String(id), {})));
  });

  expect(source).toHaveBeenCalledTimes(2);
  expect(budget.toolCalls).toBe(2);
  expect(controller.signal.reason).toEqual(new Error("Agent tool-call budget exhausted"));
});

it("denies a write alias at the last source boundary even if a caller supplied the tool", async () => {
  const controller = new AbortController();
  const source = vi.fn(async () => ({ content: [], details: {} }));
  const budget = createAgentToolExecutionBudget({
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    allowedToolNames: ["write"],
    maxToolCalls: 2,
  });
  await budget.run(async () => {
    const patch = wrapToolWithBeforeToolCallHook({
      ...createStubTool("apply_patch"),
      execute: source,
    });
    await expect(patch.execute("ungranted-alias", {})).rejects.toThrow(
      "outside this exact execution scope",
    );
  });
  expect(source).not.toHaveBeenCalled();
  expect(budget.toolCalls).toBe(0);
});

import { AsyncLocalStorage } from "node:async_hooks";
import {
  composeSessionSourceAssertion,
  runWithSessionSourceScope,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const executionBudgetContext = resolveGlobalSingleton(
  Symbol.for("openclaw.agentToolExecutionBudgetContext"),
  () =>
    new AsyncLocalStorage<{
      admit: (toolName?: string) => void;
      allowedToolNames?: ReadonlySet<string>;
      assertCurrent: () => void;
      assertHarness: (builtIn: boolean) => void;
    }>(),
);

/** One invocation owns the count and closes every tool closure it created. */
export function createAgentToolExecutionBudget(params: {
  maxToolCalls?: number;
  /** External runtimes may own tools outside this source-call budget. */
  requireNativeHarness?: boolean;
  /** Exact native names; group/alias expansion must never widen this ceiling. */
  allowedToolNames?: readonly string[];
  signal: AbortSignal;
  abort: (reason: Error) => void;
  isCurrent?: () => boolean;
}) {
  const allowedToolNames = params.allowedToolNames ? new Set(params.allowedToolNames) : undefined;
  let toolCalls = 0;
  let active = true;
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    try {
      if (!active || params.isCurrent?.() === false) {
        throw new Error("Agent tool execution scope is no longer active");
      }
    } catch (error) {
      if (error instanceof Error) {
        params.abort(error);
      }
      throw error;
    }
  };
  const admit = (toolName?: string) => {
    assertCurrent();
    if (allowedToolNames && (!toolName || !allowedToolNames.has(toolName))) {
      const error = new Error(
        `Tool ${toolName ?? "unknown"} is outside this exact execution scope`,
      );
      params.abort(error);
      throw error;
    }
    if (params.maxToolCalls !== undefined && toolCalls >= params.maxToolCalls) {
      const error = new Error("Agent tool-call budget exhausted");
      params.abort(error);
      throw error;
    }
    // This is the last synchronous source boundary, after approval/steering awaits.
    // Charging here admits exactly the cap even when sibling calls run in parallel.
    toolCalls += 1;
  };
  const assertHarness = (builtIn: boolean) => {
    assertCurrent();
    if (params.requireNativeHarness && !builtIn) {
      throw new Error("Scoped task execution requires the built-in OpenClaw harness");
    }
  };
  return {
    get toolCalls() {
      return toolCalls;
    },
    async run<T>(run: () => Promise<T>): Promise<T> {
      try {
        return await executionBudgetContext.run(
          { admit, assertCurrent, assertHarness, allowedToolNames },
          run,
        );
      } finally {
        active = false;
      }
    },
  };
}

/** The actual harness owner supplies its native brand; a matching ID is insufficient. */
export function assertAgentToolExecutionHarness(builtIn: boolean): void {
  executionBudgetContext.getStore()?.assertHarness(builtIn);
}

/** Capture at tool construction so retained tools cannot borrow a later budget. */
export function captureAgentToolExecutionBudget(
  toolName?: string,
  options?: { control?: boolean },
): (() => void) | undefined {
  const scope = executionBudgetContext.getStore();
  // Host-branded Code Mode controls carry scripts; each nested native source
  // consumes a call, while the transport still retains the deadline/close fence.
  return scope ? (options?.control ? scope.assertCurrent : () => scope.admit(toolName)) : undefined;
}

export function hasExactAgentToolExecutionScope(): boolean {
  return executionBudgetContext.getStore()?.allowedToolNames !== undefined;
}

export function isAgentToolExecutionToolAllowed(name: string): boolean {
  return executionBudgetContext.getStore()?.allowedToolNames?.has(name) ?? true;
}

/** Freeze the invocation's operational fence before asynchronous source work. */
export function captureAgentToolSourceExecutionGuard(signal?: AbortSignal): SessionSourceAssertion {
  // This host closure checks the exact delegated claim, even with audit disabled;
  // neither diagnostic identity tokens nor their collection grant authority.
  const authority = getGatewayToolCallerIdentity()?.receiptAuthority;
  const assertBudgetCurrent = executionBudgetContext.getStore()?.assertCurrent;
  const assertReceipt = Object.assign(() => {
    if (authority?.() === false) {
      throw new Error("tool invocation authority is no longer active");
    }
  }, authority);
  return composeSessionSourceAssertion([assertReceipt], (assertSource) => {
    signal?.throwIfAborted();
    assertBudgetCurrent?.();
    assertSource();
  });
}

/** Prepare storage authority for one effect; its final callback checks the retained receipt. */
export function runWithAgentToolSourceExecutionScope<T>(
  source: SessionSourceAssertion | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return runWithSessionSourceScope(source, run, { checkAfter: false });
}

const SOURCE_EXECUTION_GUARD = Symbol.for("openclaw.agentToolSourceExecutionGuard");
type GuardedAgentTool = AnyAgentTool & { [SOURCE_EXECUTION_GUARD]?: SessionSourceAssertion };

function appendSourceExecutionGuard(tool: GuardedAgentTool, guard: SessionSourceAssertion): void {
  const inherited = tool[SOURCE_EXECUTION_GUARD];
  if (inherited === guard) {
    return;
  }
  // The source edge can cross plugin views; a tool-object WeakMap loses that binding.
  Object.defineProperty(tool, SOURCE_EXECUTION_GUARD, {
    value: inherited ? composeSessionSourceAssertion([inherited, guard]) : guard,
    configurable: true,
    enumerable: false,
  });
}

/** Bind a host-owned guard without mutating a tool that another attempt may reuse. */
export function bindAgentToolSourceExecutionGuard(
  tool: AnyAgentTool,
  guard: SessionSourceAssertion,
): AnyAgentTool {
  const bound = copyAgentToolMetadata(tool, { ...tool });
  copyAgentToolSourceExecutionGuard(tool, bound);
  appendSourceExecutionGuard(bound, guard);
  return bound;
}

export function copyAgentToolSourceExecutionGuard(
  source: GuardedAgentTool,
  target: GuardedAgentTool,
): void {
  const guard = source[SOURCE_EXECUTION_GUARD];
  if (guard) {
    appendSourceExecutionGuard(target, guard);
  }
}

export function runAgentToolSourceExecutionGuard(tool: GuardedAgentTool): void {
  tool[SOURCE_EXECUTION_GUARD]?.();
}

/** Third-party tools enter their implementation with freshly prepared source authority. */
export function runWithBoundAgentToolSourceExecutionScope<T>(
  tool: GuardedAgentTool,
  run: () => Promise<T>,
): Promise<T> {
  return runWithAgentToolSourceExecutionScope(tool[SOURCE_EXECUTION_GUARD], async () => {
    runAgentToolSourceExecutionGuard(tool);
    return run();
  });
}

import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { withParentExecutionIdentity } from "../agents/subagents/spawn/execution-identity-spawn-context.js";
import { bindScopedTaskSpawnAuthority } from "../agents/subagents/spawn/scoped-task-authority.js";
import type { SpawnSubagentContext } from "../agents/subagents/spawn/subagent-spawn-contract.js";
import type { ToolFsPolicy } from "../agents/tool-fs-policy.types.js";
import type { CronToolOptions } from "../agents/tools/cron-tool.types.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

export type ScopedTaskSpec = {
  role: "worker" | "reviewer";
  tools: Array<"read" | "write" | "edit" | "apply_patch" | "exec">;
  timeoutSeconds: number;
  maxToolCalls: number;
  handoff: boolean;
};

export type ScopedTaskPreparationRequest = {
  spec: ScopedTaskSpec;
  intent: string;
  workspace: "current-project";
  sandbox: "required";
  network: "none";
};

export type ScopedTaskRunRequest = {
  sessionKey: string;
  message: string;
  timeoutSeconds: number;
  promptMode: "minimal";
  deliver: false;
  idempotencyKey: string;
  assertCurrent?: () => void;
};
export type PreparedPluginScopedTask = {
  receipt: {
    contract: "openclaw.scoped-tasks.v1";
    scope: string;
    requestSha256: string;
    workspaceId: string;
    runId: string;
    sessionKey: string;
  };
  assertCurrent: () => void;
  run: (request: ScopedTaskRunRequest) => Promise<{ runId: string; sessionKey: string }>;
};
export type OpenClawPluginToolScopedTasks = {
  version: 1;
  prepare(
    request: ScopedTaskPreparationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PreparedPluginScopedTask>;
};

type ScopedTaskSource = Pick<
  CronToolOptions,
  "creatorToolAllowlist" | "creatorToolAllowlistCaptureRef"
> & {
  workspaceDir?: string;
  spawnContext?: SpawnSubagentContext;
  fsPolicy?: ToolFsPolicy;
  /** The same current snapshot supplier used by ordinary tool construction. */
  getConfig: () => OpenClawPluginToolContext["config"];
};

const sources = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginScopedTaskSources.v1"),
  () => new WeakMap<object, ScopedTaskSource>(),
);
const allowedTools = new Set(["read", "write", "edit", "apply_patch", "exec"]);
const taskFields = new Set(["role", "tools", "timeoutSeconds", "maxToolCalls", "handoff"]);

/** Only the native tool construction owner can attach final executable-surface facts. */
export function bindPluginScopedTaskSource(context: object, source: ScopedTaskSource): void {
  sources.set(context, source);
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertRequest(request: ScopedTaskPreparationRequest): void {
  if (
    !request ||
    !nonblank(request.intent) ||
    request.intent.length > 256 ||
    Object.keys(request).some(
      (key) => !["spec", "intent", "workspace", "sandbox", "network"].includes(key),
    ) ||
    request.workspace !== "current-project" ||
    request.sandbox !== "required" ||
    request.network !== "none"
  ) {
    throw new Error("Scoped tasks require the current project, a sandbox, and network none");
  }
  const spec = request.spec;
  if (
    !spec ||
    Object.keys(spec).some((key) => !taskFields.has(key)) ||
    !["worker", "reviewer"].includes(spec.role) ||
    !Array.isArray(spec.tools) ||
    spec.tools.length === 0 ||
    spec.tools.length > allowedTools.size ||
    spec.tools.some((tool) => !allowedTools.has(tool)) ||
    new Set(spec.tools).size !== spec.tools.length ||
    (spec.role === "reviewer" && spec.tools.some((tool) => tool !== "read")) ||
    !Number.isInteger(spec.timeoutSeconds) ||
    spec.timeoutSeconds < 1 ||
    spec.timeoutSeconds > 300 ||
    !Number.isInteger(spec.maxToolCalls) ||
    spec.maxToolCalls < 1 ||
    spec.maxToolCalls > 32 ||
    typeof spec.handoff !== "boolean"
  ) {
    throw new Error("Invalid scoped task tools, role, deadline, or tool-call budget");
  }
}

/**
 * Preparation is side-effect-free; its one-use closure delegates effects to native spawn.
 */
export function createPluginToolScopedTasks(
  sourceContext: OpenClawPluginToolContext,
  context: OpenClawPluginToolContext,
  assertInvocationCurrent: () => void,
  pluginId?: string,
): OpenClawPluginToolScopedTasks | undefined {
  const source = sources.get(sourceContext);
  const project = context.activeProjectKeys;
  if (
    !source ||
    context.senderIsOwner !== true ||
    project?.length !== 1 ||
    ![
      context.requesterSenderId,
      context.messageChannel,
      context.agentAccountId,
      context.agentId,
      context.sessionKey,
      context.sessionId,
      project[0],
    ].every(nonblank)
  ) {
    return undefined;
  }
  const agentId = context.agentId!;
  const sessionKey = context.sessionKey!;
  const workspace = source.workspaceDir ?? "";
  const identity = [
    context.requesterSenderId,
    context.messageChannel,
    context.agentAccountId,
    agentId,
    sessionKey,
    context.sessionId,
    project[0],
  ];
  return {
    version: 1,
    async prepare(rawRequest, { signal }: { signal?: AbortSignal } = {}) {
      assertRequest(rawRequest);
      const request = structuredClone(rawRequest);
      const assertCurrent = () => {
        assertInvocationCurrent();
        signal?.throwIfAborted();
        assertRequest(request);
        const currentIdentity = [
          context.requesterSenderId,
          context.messageChannel,
          context.agentAccountId,
          context.agentId,
          context.sessionKey,
          context.sessionId,
          context.activeProjectKeys?.length === 1 ? context.activeProjectKeys[0] : undefined,
        ];
        if (
          context.senderIsOwner !== true ||
          identity.some((value, index) => value !== currentIdentity[index])
        ) {
          throw new Error("Scoped task caller identity changed");
        }
        const caller = getGatewayToolCallerIdentity();
        if (
          !caller ||
          caller.agentId !== agentId ||
          caller.sessionKey !== sessionKey ||
          !caller.assertToolAllowed ||
          !caller.gatewayContextResolver?.()
        ) {
          throw new Error("Scoped task admission requires the current local native tool caller");
        }
        if (source.creatorToolAllowlistCaptureRef?.value?.source !== "final-executable-surface") {
          throw new Error("Scoped task caller tool capture is incomplete");
        }
        const permitted = new Set(
          (source.creatorToolAllowlist ?? []).map((entry) =>
            typeof entry === "string" ? entry : entry.name,
          ),
        );
        for (const tool of ["sessions_spawn", ...request.spec.tools]) {
          if (!permitted.has(tool)) {
            throw new Error(`Scoped task requires permitted caller tool ${tool}`);
          }
          caller.assertToolAllowed(tool);
        }
        const config = source.getConfig();
        const sandbox = resolveSandboxConfigForAgent(config, agentId);
        if (
          !config ||
          !workspace ||
          !isAbsolute(workspace) ||
          !context.workspaceDir ||
          resolve(context.workspaceDir) !== resolve(workspace) ||
          context.sandboxed !== true ||
          sandbox.mode === "off" ||
          sandbox.backend !== "docker" ||
          sandbox.scope !== "session" ||
          sandbox.workspaceAccess !== "rw"
        ) {
          throw new Error(
            "Scoped tasks require the current project in a session Docker sandbox with rw workspace; native execution narrows its network and mounts",
          );
        }
        assertInvocationCurrent();
        signal?.throwIfAborted();
        if (request.spec.tools.includes("exec")) {
          throw new Error("Scoped exec is unavailable until owned process settlement is enforced");
        }
        const parentRoot =
          source.spawnContext?.sessionPermissionPolicy?.root ??
          (source.fsPolicy?.workspaceOnly ? source.fsPolicy.root : undefined);
        if (
          parentRoot !== undefined &&
          (!isAbsolute(parentRoot) || resolve(parentRoot) !== resolve(workspace))
        ) {
          throw new Error(
            "Scoped native spawn requires the caller's current project permission root",
          );
        }
      };
      assertCurrent();
      if (!pluginId || !source.spawnContext) {
        throw new Error("Scoped native spawn source is unavailable");
      }
      const hash = (value: unknown) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const scope = hash([
        context.messageChannel,
        context.agentAccountId,
        context.requesterSenderId,
        agentId,
        project[0],
      ]);
      const intentSha256 = hash([pluginId, scope, request.intent]);
      const requestSha256 = hash(request);
      const childSessionKey = `agent:${agentId}:subagent:plugin-${intentSha256}`;
      const runId = `plugin-task:${intentSha256}`;
      const receipt = {
        contract: "openclaw.scoped-tasks.v1" as const,
        scope,
        requestSha256,
        workspaceId: hash([project[0], workspace]),
        runId,
        sessionKey: childSessionKey,
      };
      let dispatched = false;
      return {
        receipt,
        assertCurrent,
        async run(input) {
          assertCurrent();
          if (dispatched) {
            throw new Error("Scoped task preparation was already consumed");
          }
          if (
            !input ||
            Object.keys(input).some(
              (key) =>
                ![
                  "sessionKey",
                  "message",
                  "timeoutSeconds",
                  "promptMode",
                  "deliver",
                  "idempotencyKey",
                  "assertCurrent",
                ].includes(key),
            ) ||
            input.sessionKey !== childSessionKey ||
            input.idempotencyKey !== request.intent ||
            input.timeoutSeconds !== request.spec.timeoutSeconds ||
            input.promptMode !== "minimal" ||
            !Object.is(input.deliver, false) ||
            !nonblank(input.message) ||
            input.message.length > 64000
          ) {
            throw new Error("Scoped task launch differs from its prepared admission");
          }
          const assertLaunchCurrent = () => {
            assertCurrent();
            input.assertCurrent?.();
          };
          // Consume before any await/effect; unknown admission is never replayed.
          dispatched = true;
          const { spawnSubagentDirect } =
            await import("../agents/subagents/spawn/subagent-spawn.js");
          assertLaunchCurrent();
          const caller = getGatewayToolCallerIdentity();
          const spawnContext = bindScopedTaskSpawnAuthority(
            withParentExecutionIdentity(
              {
                ...source.spawnContext,
                assertActive: assertLaunchCurrent,
                agentSessionKey: sessionKey,
                expectedParentSessionId: context.sessionId,
                senderIsOwner: true,
                requesterAgentIdOverride: agentId,
                workspaceDir: workspace,
                sandboxed: true,
                inheritedToolAllowlist: [...request.spec.tools],
              },
              caller?.executionIdentityToken,
            ),
            {
              pluginId,
              childSessionKey,
              workspaceDir: workspace,
              assertCurrent: assertLaunchCurrent,
              descriptor: {
                version: 1,
                scopeSha256: scope,
                intentSha256,
                requestSha256,
                runId,
                maxToolCalls: request.spec.maxToolCalls,
                timeoutSeconds: request.spec.timeoutSeconds,
                tools: [...request.spec.tools],
              },
            },
          );
          const result = await spawnSubagentDirect(
            {
              task: input.message,
              agentId,
              runTimeoutSeconds: request.spec.timeoutSeconds,
              mode: "run",
              cleanup: "keep",
              sandbox: "require",
              context: "isolated",
              lightContext: true,
              expectsCompletionMessage: false,
            },
            spawnContext,
          );
          if (
            result.status !== "accepted" ||
            result.runId !== runId ||
            result.childSessionKey !== childSessionKey
          ) {
            throw new Error(
              `Scoped native dispatch did not acknowledge the planned run: ${result.error ?? result.status}`,
            );
          }
          return { runId, sessionKey: childSessionKey };
        },
      };
    },
  };
}

// Real host audience minting, session storage and provider binding; fixture memory only.
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  AUDIENCE_CHILD_KEY,
  AUDIENCE_ROOT_KEY,
  NATIVE_PROVIDER_ID,
  withChildAudience,
  withNativeMemoryProvider,
} from "./memory-provider-runtime.audience.test-support.js";
import type { MemoryCallerContext, MemoryProviderHandle } from "./memory-provider-types.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRecord } from "./status.test-helpers.js";
import { createPluginToolFactoryContext } from "./tool-factory-context.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

function toolContext(context: OpenClawPluginToolContext, version2 = true) {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({ id: "memory-consumer", contracts: { tools: ["probe"] } });
  builder.registry.plugins.push(record);
  builder
    .createApi(record, { config: {}, registrationMode: "full" })
    .registerTool(version2 ? { contextVersion: 2, create: () => null } : () => null, {
      name: "probe",
    });
  return createPluginToolFactoryContext({
    entry: builder.registry.tools[0]!,
    registry: builder.registry,
    context,
    assertInvocationCurrent() {},
  });
}

function provider(context: MemoryCallerContext, beforeRead = async () => {}) {
  return {
    capabilities: { sources: ["memory"], pagination: false, candidates: [], projectFilter: true },
    search: vi.fn<MemoryProviderHandle["search"]>(async (request) => {
      await beforeRead();
      context.assertCurrent();
      return {
        hits: [
          {
            reference: { providerId: NATIVE_PROVIDER_ID, id: request.activeProjectKeys![0]! },
            excerpt: "fixture only",
          },
        ],
      };
    }),
    get: async () => ({ status: "not_found" as const }),
    health: async () => ({ status: "ready" as const }),
    close: vi.fn(async () => {}),
  } satisfies MemoryProviderHandle;
}

it("constructs a caller-bound capability with real host audience and a registered provider", async () => {
  await withChildAudience(true, async ({ audience, child }) => {
    const opened: ReturnType<typeof provider>[] = [];
    await withNativeMemoryProvider(
      (caller) => {
        expect(caller.authority).toMatchObject({
          kind: "session",
          sessionKey: AUDIENCE_CHILD_KEY,
          audience,
        });
        const handle = provider(caller);
        opened.push(handle);
        return handle;
      },
      async () => {
        const context = toolContext({
          config: {},
          agentId: "main",
          sessionKey: AUDIENCE_CHILD_KEY,
          sessionId: child.sessionId,
          memoryAudience: audience,
          activeProjectKeys: ["fixture-project"],
        });
        expect(
          toolContext(
            {
              config: {},
              agentId: "main",
              sessionKey: AUDIENCE_CHILD_KEY,
              sessionId: child.sessionId,
              memoryAudience: audience,
              activeProjectKeys: ["fixture-project"],
            },
            false,
          ).memory,
        ).toBeUndefined();
        const page = await context.memory!.search({ query: "fixture" });
        expect(page.hits[0]!.reference.id).toBe("fixture-project");
        expect(opened[0]!.close).toHaveBeenCalledOnce();
        expect(() =>
          toolContext({
            config: {},
            agentId: "main",
            sessionKey: AUDIENCE_ROOT_KEY,
            sessionId: child.sessionId,
            memoryAudience: audience,
            activeProjectKeys: ["other"],
          }),
        ).toThrow("different session");
      },
    );
  });
});

it("withholds a pending plugin search when the real parent session is reset", async () => {
  await withChildAudience(true, async ({ audience, root, child, write }) => {
    const entered = createDeferredCore(),
      release = createDeferredCore();
    let handle: ReturnType<typeof provider>;
    await withNativeMemoryProvider(
      (caller) => {
        handle = provider(caller, async () => {
          entered.resolve();
          await release.promise;
        });
        return handle;
      },
      async () => {
        const context = toolContext({
          config: {},
          agentId: "main",
          sessionKey: AUDIENCE_CHILD_KEY,
          sessionId: child.sessionId,
          memoryAudience: audience,
          activeProjectKeys: ["fixture-project"],
        });
        const pending = context.memory!.search({ query: "fixture" });
        await entered.promise;
        write(AUDIENCE_ROOT_KEY, { ...root, sessionId: randomUUID(), updatedAt: 2 });
        release.resolve();
        await expect(pending).rejects.toThrow("memory audience is no longer current");
        expect(handle!.close).toHaveBeenCalledOnce();
      },
    );
  });
});

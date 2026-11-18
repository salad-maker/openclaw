import type { MemorySearchPage } from "./memory-provider-runtime-types.js";
import type { MemoryCallerContext } from "./memory-provider-types.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

/** Search under the host's current memory audience; IDs are never an access grant. */
export type OpenClawPluginToolMemory = {
  search(
    params: { query: string; maxResults?: number; minScore?: number },
    signal?: AbortSignal,
  ): Promise<MemorySearchPage>;
};

/**
 * Only the tool-context owner calls this factory. The resulting capability captures
 * the admitted session/audience/projects rather than accepting plugin-selected owners.
 */
export function createPluginToolMemory(
  context: OpenClawPluginToolContext,
  assertCurrent: () => void,
): OpenClawPluginToolMemory | undefined {
  const { agentId, sessionKey, sessionId, memoryAudience } = context;
  const activeProjectKeys = context.activeProjectKeys
    ? Object.freeze([...context.activeProjectKeys])
    : undefined;
  const sandboxed = context.sandboxed === true;
  if (!agentId || !sessionKey || !sessionId || !memoryAudience || !activeProjectKeys?.length) {
    return undefined;
  }
  return {
    async search(params, signal) {
      const { query, minScore } = params;
      assertCurrent();
      signal?.throwIfAborted();
      if (typeof query !== "string" || !query.trim() || query.length > 2_000) {
        throw new Error("Memory query must contain 1–2000 characters");
      }
      const maxResults = params.maxResults ?? 4;
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 8) {
        throw new Error("Memory search maxResults must be an integer from 1 to 8");
      }
      if (minScore !== undefined && (!Number.isFinite(minScore) || minScore < 0 || minScore > 1)) {
        throw new Error("Memory search minScore must be between 0 and 1");
      }
      const cfg = context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config;
      if (!cfg) {
        throw new Error("Memory search runtime configuration is unavailable");
      }
      const caller: MemoryCallerContext = {
        authority: {
          kind: "session",
          sessionKey,
          sessionId,
          sandboxed,
          audience: memoryAudience,
        },
        assertCurrent,
        signal,
      };
      const { getActiveMemoryProviderCore } = await import("./memory-runtime.js");
      assertCurrent();
      signal?.throwIfAborted();
      const { provider } = await getActiveMemoryProviderCore({
        cfg,
        agentId,
        context: caller,
      });
      if (!provider) {
        throw new Error("The active memory provider is unavailable");
      }
      try {
        assertCurrent();
        signal?.throwIfAborted();
        if (
          !provider.capabilities.projectFilter ||
          !provider.capabilities.sources.includes("memory")
        ) {
          throw new Error("The active memory provider cannot enforce project-scoped memory search");
        }
        const page = await provider.search({
          query,
          maxResults,
          minScore,
          sources: ["memory"],
          activeProjectKeys,
        });
        assertCurrent();
        signal?.throwIfAborted();
        return { ...page, hits: page.hits.slice(0, maxResults) };
      } finally {
        // Release this caller's lease even after invocation/audience revocation.
        await provider.close();
      }
    },
  };
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { MemoryProviderHandle } from "./memory-provider-types.js";
import { createPluginToolMemory } from "./tool-memory.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

const { openProvider } = vi.hoisted(() => ({ openProvider: vi.fn() }));
vi.mock("./memory-runtime.js", () => ({ getActiveMemoryProviderCore: openProvider }));

function fixture() {
  const context: OpenClawPluginToolContext = {
    config: {},
    agentId: "main",
    sessionKey: "agent:main:fixture",
    sessionId: "fixture-session",
    // The provider owner tests minting/lineage; this test checks exact forwarding.
    memoryAudience: { kind: "owner-private", agentId: "main" },
    activeProjectKeys: ["project-one"],
  };
  const search = vi.fn(async () => ({ hits: [] }));
  const close = vi.fn(async () => {});
  const provider: MemoryProviderHandle = {
    capabilities: { sources: ["memory"], projectFilter: true, pagination: false, candidates: [] },
    search,
    get: async () => ({ status: "not_found" }),
    health: async () => ({ status: "ready" }),
    close,
  };
  openProvider.mockResolvedValue({ provider });
  return { context, provider, search, close };
}

beforeEach(() => openProvider.mockReset());

describe("host-bound plugin memory search", () => {
  it("requires the host audience/session/project", () => {
    const { context } = fixture();
    for (const field of [
      "agentId",
      "sessionKey",
      "sessionId",
      "memoryAudience",
      "activeProjectKeys",
    ] as const) {
      expect(createPluginToolMemory({ ...context, [field]: undefined }, () => {})).toBeUndefined();
    }
    expect(openProvider).not.toHaveBeenCalled();
  });

  it("passes only the captured authority and project filter, then releases its lease", async () => {
    const { context, search, close } = fixture();
    const assertCurrent = vi.fn();
    await createPluginToolMemory(context, assertCurrent)!.search({ query: "next step" });
    expect(openProvider).toHaveBeenCalledWith({
      cfg: context.config,
      agentId: "main",
      context: {
        authority: {
          kind: "session",
          sessionKey: context.sessionKey,
          sessionId: context.sessionId,
          sandboxed: false,
          audience: context.memoryAudience,
        },
        assertCurrent,
        signal: undefined,
      },
    });
    expect(search).toHaveBeenCalledWith({
      query: "next step",
      maxResults: 4,
      minScore: undefined,
      sources: ["memory"],
      activeProjectKeys: ["project-one"],
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not allow later caller mutations to broaden captured project or sandbox scope", async () => {
    const { context, search } = fixture();
    context.sandboxed = true;
    const capability = createPluginToolMemory(context, () => {})!;
    context.activeProjectKeys!.push("other-project");
    context.sandboxed = false;
    await capability.search({ query: "next" });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ activeProjectKeys: ["project-one"] }),
    );
    expect(openProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          authority: expect.objectContaining({ sandboxed: true }),
        }),
      }),
    );
  });

  it("fails closed when the provider cannot enforce the project filter", async () => {
    const { context, provider, search, close } = fixture();
    provider.capabilities.projectFilter = false;
    await expect(
      createPluginToolMemory(context, () => {})!.search({ query: "next" }),
    ).rejects.toThrow("project-scoped");
    expect(search).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("withholds results after caller revocation and still closes the lease", async () => {
    const { context, search, close } = fixture();
    const pending = createDeferred<{ hits: [] }>();
    search.mockReturnValue(pending.promise);
    let revoked = false;
    const capability = createPluginToolMemory(context, () => {
      if (revoked) {
        throw new Error("revoked");
      }
    })!;
    const result = capability.search({ query: "next" });
    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
    revoked = true;
    pending.resolve({ hits: [] });
    await expect(result).rejects.toThrow("revoked");
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects unbounded input before touching the provider", async () => {
    const { context } = fixture();
    const capability = createPluginToolMemory(context, () => {})!;
    await expect(capability.search({ query: "x".repeat(2001) })).rejects.toThrow("2000");
    await expect(capability.search({ query: "x", maxResults: 9 })).rejects.toThrow("1 to 8");
    expect(openProvider).not.toHaveBeenCalled();
  });
});

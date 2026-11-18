import { expect, it } from "vitest";
import {
  bindScopedTaskSpawnAuthority,
  readScopedTaskSpawnAuthority,
} from "./scoped-task-authority.js";

it("carries only a live host-minted token through native context copies", () => {
  let current = true;
  const grant = {
    pluginId: "fixture",
    workspaceDir: "/fixture/project",
    childSessionKey: "agent:main:subagent:fixture",
    descriptor: {
      version: 1 as const,
      intentSha256: "intent",
      scopeSha256: "scope",
      requestSha256: "request",
      runId: "run",
      maxToolCalls: 1,
      timeoutSeconds: 5,
      tools: ["read"],
    },
    assertCurrent() {
      if (!current) {
        throw new Error("owner closed");
      }
    },
  };
  const context = bindScopedTaskSpawnAuthority({}, grant);
  expect(readScopedTaskSpawnAuthority({ ...context })).toBe(grant);
  current = false;
  expect(() => readScopedTaskSpawnAuthority({ ...context })).toThrow("owner closed");
});

it.each([undefined, null, {}, "forged"])(
  "rejects an unknown marked context before ordinary dispatch (%s)",
  (token) => {
    expect(() =>
      readScopedTaskSpawnAuthority({ [Symbol.for("openclaw.scopedTaskSpawnAuthority.v1")]: token }),
    ).toThrow("refusing ordinary dispatch");
    expect(readScopedTaskSpawnAuthority({})).toBeUndefined();
  },
);

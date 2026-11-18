import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, resolve } from "node:path";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { SandboxConfig } from "./types.js";

type ScopedTaskWorkspaceAuthority = {
  agentId: string;
  sessionKey: string;
  workspaceDir: string;
  workspaceAccess: "ro" | "rw";
  assertCurrent: () => void;
};

// Only the native execution owner enters this scope after the irreversible run
// claim. It is not an SDK capability, session setting, or model argument.
const authority = resolveGlobalSingleton(
  Symbol.for("openclaw.scopedTaskWorkspaceAuthority.v1"),
  () => new AsyncLocalStorage<ScopedTaskWorkspaceAuthority>(),
);

export async function withScopedTaskWorkspaceAuthority<T>(
  source: ScopedTaskWorkspaceAuthority,
  run: () => Promise<T>,
): Promise<T> {
  source.assertCurrent();
  if (
    !source.agentId ||
    !source.sessionKey ||
    !["ro", "rw"].includes(source.workspaceAccess) ||
    !isAbsolute(source.workspaceDir) ||
    authority.getStore()
  ) {
    throw new Error("Scoped task workspace authority requires one exact native owner");
  }
  let open = true;
  const grant = Object.freeze({
    ...source,
    workspaceDir: resolve(source.workspaceDir),
    assertCurrent() {
      if (!open) {
        throw new Error("Scoped task workspace authority is closed");
      }
      source.assertCurrent();
    },
  });
  try {
    return await authority.run(grant, run);
  } finally {
    open = false;
  }
}

export function readScopedTaskWorkspaceAuthority(target: {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
}): ScopedTaskWorkspaceAuthority | undefined {
  const grant = authority.getStore();
  if (!grant || target.agentId !== grant.agentId || target.sessionKey !== grant.sessionKey) {
    return undefined;
  }
  grant.assertCurrent();
  if (
    target.workspaceDir !== undefined &&
    (!isAbsolute(target.workspaceDir) || resolve(target.workspaceDir) !== grant.workspaceDir)
  ) {
    throw new Error("Scoped task cannot substitute its authorized project workspace");
  }
  return grant;
}

/** Tool construction inside a claimed task cannot fall back to another or absent owner. */
export function requireScopedTaskToolWorkspace(target: {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
}) {
  if (!authority.getStore()) {
    return undefined;
  }
  const grant = readScopedTaskWorkspaceAuthority(target);
  if (!grant) {
    throw new Error("Scoped task file tools require their exact native owner");
  }
  return grant;
}

/** Shared by allocation and the final file-effect guard; never changes parent config. */
export function resolveScopedTaskSandboxConfig(target: {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  configured: SandboxConfig;
}): SandboxConfig | undefined {
  const grant = readScopedTaskWorkspaceAuthority(target);
  if (!grant) {
    return undefined;
  }
  const configured = target.configured;
  if (
    configured.mode === "off" ||
    configured.backend !== "docker" ||
    configured.scope !== "session" ||
    configured.workspaceAccess !== "rw"
  ) {
    throw new Error("Scoped task lost its configured Docker session project access");
  }
  return {
    ...configured,
    scope: "session",
    workspaceAccess: grant.workspaceAccess,
    docker: {
      ...configured.docker,
      network: "none",
      binds: [],
      readOnlyRoot: true,
      capDrop: ["ALL"],
      env: {},
      setupCommand: undefined,
      dangerouslyAllowReservedContainerTargets: false,
      dangerouslyAllowExternalBindSources: false,
      dangerouslyAllowContainerNamespaceJoin: false,
    },
    browser: { ...configured.browser, enabled: false },
    prune: { ...configured.prune, idleHours: 0, maxAgeDays: 0 },
  };
}

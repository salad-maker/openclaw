import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import type { SpawnSubagentContext } from "./subagent-spawn-contract.js";

export type ScopedTaskSpawnAuthority = {
  pluginId: string;
  childSessionKey: string;
  workspaceDir: string;
  descriptor: NonNullable<InternalSessionEntry["pluginScopedTask"]>;
  assertCurrent: () => void;
};

// Symbol propagation survives native context copies; the symbol never crosses
// a model/JSON boundary and is not part of the public spawn parameter contract.
const authorityKey = Symbol.for("openclaw.scopedTaskSpawnAuthority.v1");
const authorities = resolveGlobalSingleton(
  Symbol.for("openclaw.scopedTaskSpawnAuthorities.v1"),
  () => new WeakMap<object, ScopedTaskSpawnAuthority>(),
);
type BoundContext = SpawnSubagentContext & { [authorityKey]?: unknown };

export function bindScopedTaskSpawnAuthority(
  context: SpawnSubagentContext,
  authority: ScopedTaskSpawnAuthority,
): SpawnSubagentContext {
  authority.assertCurrent();
  const token = Object.freeze({});
  authorities.set(token, authority);
  return Object.assign(context, { [authorityKey]: token });
}

export function readScopedTaskSpawnAuthority(
  context: SpawnSubagentContext,
): ScopedTaskSpawnAuthority | undefined {
  if (!(authorityKey in context)) {
    return undefined;
  }
  const token = (context as BoundContext)[authorityKey];
  const authority = token && typeof token === "object" ? authorities.get(token) : undefined;
  if (!authority) {
    throw new Error("Scoped task spawn authority is unavailable; refusing ordinary dispatch");
  }
  authority.assertCurrent();
  return authority;
}

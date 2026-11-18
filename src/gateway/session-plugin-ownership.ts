import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry, InternalSessionEntry } from "../config/sessions.js";

/** Plugin callers may access an existing session only when they own its exact row. */
export function resolvePluginSessionOwnershipError(params: {
  action: "adopt" | "delete" | "fork" | "link" | "patch" | "recover" | "reset";
  entry: SessionEntry | undefined;
  key: string;
  pluginOwnerId: string | null | undefined;
}): ErrorShape | undefined {
  const pluginOwnerId = normalizeOptionalString(params.pluginOwnerId);
  if (
    !pluginOwnerId ||
    !params.entry ||
    normalizeOptionalString(params.entry.pluginOwnerId) === pluginOwnerId
  ) {
    return undefined;
  }
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `Plugin "${pluginOwnerId}" cannot ${params.action} session "${params.key}" because it did not create it.`,
  );
}

export function resolveResetOwnershipError(
  entry: InternalSessionEntry | undefined,
  key: string,
  pluginOwnerId: string | null | undefined,
) {
  return entry?.pluginScopedTask
    ? errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Scoped task sessions cannot be reset; retain their immutable execution claim and create a new task intent.",
      )
    : resolvePluginSessionOwnershipError({
        action: "reset",
        entry,
        key,
        pluginOwnerId,
      });
}

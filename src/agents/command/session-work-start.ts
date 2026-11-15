import { createSessionWorkStartChangedError } from "../../config/sessions/lifecycle.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../../config/sessions/session-actor-storage-binding.js";
import { resolveSessionWorkStartBlock } from "../../config/sessions/session-work-start.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { prepareAgentCommandExecution } from "./prepare.js";
import { loadSessionStoreRuntime } from "./runtime-loaders.js";

type Prepared = Awaited<ReturnType<typeof prepareAgentCommandExecution>>;

export function captureAgentCommandSessionSource(prepared: Prepared) {
  return prepared.sessionKey
    ? captureSessionActorStorageOwner(
        {
          agentId: prepared.sessionAgentId,
          storePath: prepared.storePath,
          sessionKey: prepared.sessionKey,
        },
        {
          assertCurrent() {
            prepared.opts.assertSourceCurrent?.();
          },
          authorize() {},
        },
      )
    : undefined;
}

/** Read and validate the native row after work admission, before any execution claim. */
export async function readAgentCommandWorkStartEntry(params: {
  prepared: Prepared;
  sessionSource: ReturnType<typeof captureAgentCommandSessionSource>;
  sessionEntry: InternalSessionEntry | undefined;
  preparedSessionId: string | undefined;
}): Promise<InternalSessionEntry | undefined> {
  const { prepared, sessionSource, sessionEntry, preparedSessionId } = params;
  const { storePath, sessionKey, sessionId, sessionAgentId, isNewSession } = prepared;
  const runtime = storePath && sessionKey ? await loadSessionStoreRuntime() : undefined;
  const currentEntry =
    runtime && storePath && sessionKey
      ? sessionSource
        ? readCapturedSessionActorEntry(sessionSource, normalizeStoreSessionKey(sessionKey))
        : await runtime.readSessionEntryInWorker({
            agentId: sessionAgentId,
            storePath,
            sessionKey,
            readConsistency: "latest",
          })
      : sessionEntry;
  if (!currentEntry && preparedSessionId) {
    throw createSessionWorkStartChangedError(sessionKey ?? sessionId);
  }
  const matchesIntentionalRollover = isNewSession && currentEntry?.sessionId === preparedSessionId;
  if (currentEntry && currentEntry.sessionId !== sessionId && !matchesIntentionalRollover) {
    throw createSessionWorkStartChangedError(sessionKey ?? sessionId);
  }
  const error = resolveSessionWorkStartBlock(sessionKey ?? sessionId, currentEntry);
  if (error) {
    throw error;
  }
  return currentEntry;
}

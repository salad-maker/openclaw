import { randomUUID } from "node:crypto";
import { getInProcessGatewayRequestContext } from "../plugins/runtime/gateway-request-scope.js";
import { createMcpClientElicitationHandler } from "./mcp-client-elicitation.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

export function registerNodeToolElicitation(
  nodeId: string,
  sessionKey: string | undefined,
  signal?: AbortSignal,
) {
  const caller = getGatewayToolCallerIdentity();
  const assertCurrent = captureGatewayToolCallerAssertion();
  if (!caller || !assertCurrent || caller.sessionKey !== sessionKey) {
    return undefined;
  }
  const registry = getInProcessGatewayRequestContext(caller.gatewayContextResolver)?.nodeRegistry;
  const node = registry?.get(nodeId);
  if (!registry || !node) {
    return undefined;
  }
  assertCurrent();
  const id = randomUUID();
  const handle = createMcpClientElicitationHandler({
    sessionKey,
    agentId: caller.agentId,
    assertCurrent,
  });
  const release = registry.mcpElicitation.register({
    id,
    node,
    signal: AbortSignal.any([...(caller.approvalSignals ?? []), ...(signal ? [signal] : [])]),
    handle,
  });
  return { id, [Symbol.dispose]: release };
}

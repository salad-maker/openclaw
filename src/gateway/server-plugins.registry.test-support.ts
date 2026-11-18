import { createPluginRecord } from "../plugins/loader-records.js";
import type { PluginDiagnostic } from "../plugins/manifest-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry.js";

export const createRegistry = (diagnostics: PluginDiagnostic[]): PluginRegistry => ({
  ...createEmptyPluginRegistry(),
  diagnostics,
});

export function addLoadedPlugin(
  registry: PluginRegistry,
  params: {
    id: string;
    origin?: PluginRegistry["plugins"][number]["origin"];
    trustedOfficialInstall?: boolean;
  },
): PluginRegistry {
  registry.plugins.push(
    createPluginRecord({
      id: params.id,
      name: params.id,
      source: `/tmp/${params.id}/index.js`,
      origin: params.origin ?? "bundled",
      enabled: true,
      configSchema: false,
      ...(params.trustedOfficialInstall !== undefined
        ? { trustedOfficialInstall: params.trustedOfficialInstall }
        : {}),
    }),
  );
  return registry;
}

export function createDuplexPluginRegistry(command = "image.bridge"): PluginRegistry {
  const registry = addLoadedPlugin(createRegistry([]), { id: "duplex-plugin" });
  registry.nodeHostCommands.push({
    pluginId: "duplex-plugin",
    pluginName: "Duplex plugin",
    command: { command, duplex: true, handle: async () => "{}" },
    source: "test",
  });
  return registry;
}

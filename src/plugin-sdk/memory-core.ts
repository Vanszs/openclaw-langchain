// Narrow plugin-sdk surface for the bundled memory-core plugin.
// Keep this list additive and scoped to symbols used under extensions/memory-core.

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export {
  clearMemoryCliProvidersForTests,
  getMemoryCliProvider,
  registerMemoryCliProvider,
} from "../memory/plugin-cli-registry.js";
export type { MemoryCliProvider, MemoryCliProviderContext } from "../memory/plugin-cli-registry.js";
export {
  clearMemoryManagerProvidersForTests,
  getMemoryManagerProvider,
  registerMemoryManagerProvider,
} from "../memory/plugin-manager-registry.js";
export type {
  MemoryManagerProvider,
  MemoryManagerProviderContext,
} from "../memory/plugin-manager-registry.js";
export type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "../memory/types.js";

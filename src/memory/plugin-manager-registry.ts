import type { OpenClawConfig } from "../config/config.js";
import type { MemorySearchManager } from "./types.js";

export type MemoryManagerProviderContext = {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  purpose?: "default" | "status";
};

export type MemoryManagerProvider = (
  ctx: MemoryManagerProviderContext,
) => MemorySearchManager | null | Promise<MemorySearchManager | null>;

const MEMORY_MANAGER_PROVIDERS_KEY = Symbol.for("openclaw.memoryManagerProviders");

function getMemoryManagerProvidersStore(): Map<string, MemoryManagerProvider> {
  const globalState = globalThis as typeof globalThis & {
    [MEMORY_MANAGER_PROVIDERS_KEY]?: Map<string, MemoryManagerProvider>;
  };
  globalState[MEMORY_MANAGER_PROVIDERS_KEY] ??= new Map<string, MemoryManagerProvider>();
  return globalState[MEMORY_MANAGER_PROVIDERS_KEY];
}

export function registerMemoryManagerProvider(
  pluginId: string,
  provider: MemoryManagerProvider,
): void {
  const normalizedId = pluginId.trim();
  if (!normalizedId) {
    throw new Error("memory manager provider requires a plugin id");
  }
  getMemoryManagerProvidersStore().set(normalizedId, provider);
}

export function getMemoryManagerProvider(pluginId: string): MemoryManagerProvider | null {
  const normalizedId = pluginId.trim();
  if (!normalizedId) {
    return null;
  }
  return getMemoryManagerProvidersStore().get(normalizedId) ?? null;
}

export function clearMemoryManagerProvidersForTests(): void {
  getMemoryManagerProvidersStore().clear();
}

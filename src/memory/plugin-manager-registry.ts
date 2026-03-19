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

const MEMORY_MANAGER_PROVIDERS = new Map<string, MemoryManagerProvider>();

export function registerMemoryManagerProvider(
  pluginId: string,
  provider: MemoryManagerProvider,
): void {
  const normalizedId = pluginId.trim();
  if (!normalizedId) {
    throw new Error("memory manager provider requires a plugin id");
  }
  MEMORY_MANAGER_PROVIDERS.set(normalizedId, provider);
}

export function getMemoryManagerProvider(pluginId: string): MemoryManagerProvider | null {
  const normalizedId = pluginId.trim();
  if (!normalizedId) {
    return null;
  }
  return MEMORY_MANAGER_PROVIDERS.get(normalizedId) ?? null;
}

export function clearMemoryManagerProvidersForTests(): void {
  MEMORY_MANAGER_PROVIDERS.clear();
}

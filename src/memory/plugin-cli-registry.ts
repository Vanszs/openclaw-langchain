import type { Command } from "commander";
import type { OpenClawConfig } from "../config/config.js";

export type MemoryCliProviderContext = {
  program: Command;
  config: OpenClawConfig;
};

export type MemoryCliProvider = (ctx: MemoryCliProviderContext) => void;

const MEMORY_CLI_PROVIDERS = new Map<string, MemoryCliProvider>();

export function registerMemoryCliProvider(pluginId: string, provider: MemoryCliProvider): void {
  const normalizedId = pluginId.trim();
  if (!normalizedId) {
    throw new Error("memory CLI provider requires a plugin id");
  }
  MEMORY_CLI_PROVIDERS.set(normalizedId, provider);
}

export function getMemoryCliProvider(pluginId: string): MemoryCliProvider | null {
  const normalizedId = pluginId.trim();
  if (!normalizedId) {
    return null;
  }
  return MEMORY_CLI_PROVIDERS.get(normalizedId) ?? null;
}

export function clearMemoryCliProvidersForTests(): void {
  MEMORY_CLI_PROVIDERS.clear();
}

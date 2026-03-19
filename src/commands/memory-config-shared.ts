import type { OpenClawConfig } from "../config/config.js";
import type { MemorySearchConfig } from "../config/types.tools.js";
import { applyExclusiveSlotSelection } from "../plugins/slots.js";

export type MemoryBackendSelection = "memory-core" | "memory-langchain" | "none";
export type MemoryRecallScope = "global" | "session" | "prefer_session";
export type MemorySourceSelection = NonNullable<MemorySearchConfig["sources"]>[number];

export type MemoryConfigInput = {
  backend: MemoryBackendSelection;
  workspaceDir: string;
  chromaUrl?: string;
  collectionPrefix?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  apiKeySecretRef?: string;
  sources?: MemorySourceSelection[];
  roots?: string[];
  extraPaths?: string[];
  scope?: MemoryRecallScope;
};

export function parseDelimitedList(input: string | undefined): string[] {
  if (typeof input !== "string") {
    return [];
  }
  return input
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const MEMORY_SOURCE_SET = new Set<MemorySourceSelection>([
  "memory",
  "sessions",
  "repo",
  "docs",
  "chat",
  "email",
]);

export function parseMemorySourceList(input: string | undefined): MemorySourceSelection[] {
  return parseDelimitedList(input).filter((entry): entry is MemorySourceSelection =>
    MEMORY_SOURCE_SET.has(entry as MemorySourceSelection),
  );
}

export function applyMemoryConfig(
  nextConfig: OpenClawConfig,
  input: MemoryConfigInput,
): OpenClawConfig {
  if (input.backend === "none") {
    return {
      ...nextConfig,
      plugins: {
        ...nextConfig.plugins,
        slots: {
          ...nextConfig.plugins?.slots,
          memory: "none",
        },
      },
    };
  }

  const slotConfig = applyExclusiveSlotSelection({
    config: nextConfig,
    selectedId: input.backend,
    selectedKind: "memory",
  }).config;

  if (input.backend === "memory-core") {
    return slotConfig;
  }

  const currentLangchain = (slotConfig.plugins?.entries?.["memory-langchain"]?.config ??
    {}) satisfies Record<string, unknown>;
  const currentMemorySearch = slotConfig.agents?.defaults?.memorySearch;

  return {
    ...slotConfig,
    plugins: {
      ...slotConfig.plugins,
      entries: {
        ...slotConfig.plugins?.entries,
        "memory-langchain": {
          ...slotConfig.plugins?.entries?.["memory-langchain"],
          enabled: true,
          config: {
            ...currentLangchain,
            chromaUrl: input.chromaUrl || "http://127.0.0.1:8000",
            collectionPrefix: input.collectionPrefix || "openclaw",
            embeddingProvider: input.embeddingProvider || "openai",
            embeddingModel: input.embeddingModel || "text-embedding-3-small",
            ...(input.apiKeySecretRef ? { apiKeySecretRef: input.apiKeySecretRef } : {}),
          },
        },
      },
    },
    agents: {
      ...slotConfig.agents,
      defaults: {
        ...slotConfig.agents?.defaults,
        memorySearch: {
          ...currentMemorySearch,
          ...(input.sources ? { sources: input.sources } : {}),
          roots: input.roots && input.roots.length > 0 ? input.roots : [input.workspaceDir],
          ...(input.extraPaths ? { extraPaths: input.extraPaths } : {}),
          query: {
            ...currentMemorySearch?.query,
            scope: input.scope || "prefer_session",
          },
        },
      },
    },
  };
}

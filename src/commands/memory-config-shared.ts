import type { OpenClawConfig } from "../config/config.js";
import type { MemorySearchConfig } from "../config/types.tools.js";
import { applyExclusiveSlotSelection } from "../plugins/slots.js";

export type MemoryBackendSelection = "memory-core" | "memory-langchain" | "none";
export type MemoryRecallScope = "global" | "session" | "prefer_session";
export type MemorySourceSelection = NonNullable<MemorySearchConfig["sources"]>[number];

export const DEFAULT_CHROMA_URL = "http://127.0.0.1:8000";

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

function normalizeOptionalString(input: string | undefined): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const trimmed = input.trim();
  return trimmed || undefined;
}

export function resolveConfiguredChromaUrl(currentValue?: unknown): string {
  const configured =
    typeof currentValue === "string" && currentValue.trim() ? currentValue.trim() : undefined;
  const envValue = normalizeOptionalString(process.env.OPENCLAW_CHROMA_URL);
  return configured || envValue || DEFAULT_CHROMA_URL;
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

export function findInvalidMemorySources(input: string | undefined): string[] {
  return parseDelimitedList(input).filter(
    (entry) => !MEMORY_SOURCE_SET.has(entry as MemorySourceSelection),
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
        entries: {
          ...nextConfig.plugins?.entries,
          ...(nextConfig.plugins?.entries?.["memory-langchain"]
            ? {
                "memory-langchain": {
                  ...nextConfig.plugins.entries["memory-langchain"],
                  enabled: false,
                },
              }
            : {}),
        },
      },
    };
  }

  const slotConfig = applyExclusiveSlotSelection({
    config: nextConfig,
    selectedId: input.backend,
    selectedKind: "memory",
  }).config;
  const currentMemorySearch = slotConfig.agents?.defaults?.memorySearch;
  const nextMemorySearch = {
    ...currentMemorySearch,
    ...(input.sources ? { sources: input.sources } : {}),
    roots: input.roots && input.roots.length > 0 ? input.roots : [input.workspaceDir],
    ...(input.extraPaths ? { extraPaths: input.extraPaths } : {}),
    query: {
      ...currentMemorySearch?.query,
      scope: input.scope || "prefer_session",
    },
  };

  if (input.backend === "memory-core") {
    return {
      ...slotConfig,
      plugins: {
        ...slotConfig.plugins,
        entries: {
          ...slotConfig.plugins?.entries,
          ...(slotConfig.plugins?.entries?.["memory-langchain"]
            ? {
                "memory-langchain": {
                  ...slotConfig.plugins.entries["memory-langchain"],
                  enabled: false,
                },
              }
            : {}),
        },
      },
      agents: {
        ...slotConfig.agents,
        defaults: {
          ...slotConfig.agents?.defaults,
          memorySearch: nextMemorySearch,
        },
      },
    };
  }

  const currentLangchain = (slotConfig.plugins?.entries?.["memory-langchain"]?.config ??
    {}) satisfies Record<string, unknown>;
  const requestedChromaUrl = normalizeOptionalString(input.chromaUrl);
  const chromaUrl = requestedChromaUrl ?? resolveConfiguredChromaUrl(currentLangchain.chromaUrl);

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
            chromaUrl,
            collectionPrefix: input.collectionPrefix || "openclaw",
            embeddingProvider: input.embeddingProvider === "openrouter" ? "openrouter" : "openai",
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
        memorySearch: nextMemorySearch,
      },
    },
  };
}

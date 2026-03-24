import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { MemorySearchConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveConfiguredSecretInputWithFallback,
  resolveStateDir,
} from "openclaw/plugin-sdk/config-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/core";

export const LANGCHAIN_MEMORY_PLUGIN_ID = "memory-langchain";
export const LANGCHAIN_VIRTUAL_ROOT = "langchain";

export type LangchainMemorySource = "memory" | "sessions" | "repo" | "docs" | "chat" | "email";
export type LangchainMemoryScope = "global" | "session" | "prefer_session";
export type LangchainMemoryDomain = "user_memory" | "docs_kb" | "history";

export type LangchainPluginConfig = {
  chromaUrl: string;
  collectionPrefix: string;
  embeddingProvider: string;
  embeddingModel: string;
  apiKey?: string;
  apiKeyConfigured: boolean;
  apiKeyUnresolvedReason?: string;
  chunkSize: number;
  chunkOverlap: number;
  batchSize: number;
  syncIntervalSec: number;
  queueDir: string;
  baseDir: string;
  documentsDir: string;
  pendingDir: string;
  statusPath: string;
  manifestPath: string;
  logsPath: string;
};

export type LangchainPluginStorageState = Omit<
  LangchainPluginConfig,
  "apiKey" | "apiKeyConfigured" | "apiKeyUnresolvedReason"
>;

export type LangchainAgentConfig = {
  agentId: string;
  workspaceDir: string;
  sources: LangchainMemorySource[];
  roots: string[];
  extraPaths: string[];
  scope: LangchainMemoryScope;
  maxResults: number;
  minScore: number;
};

const DEFAULT_SOURCES: LangchainMemorySource[] = [
  "memory",
  "repo",
  "docs",
  "chat",
  "email",
  "sessions",
];

const DEFAULT_CHROMA_URL = "http://127.0.0.1:8000";

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeString(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function expandHome(input: string): string {
  if (!input.startsWith("~")) {
    return input;
  }
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolvePathLike(input: string, baseDir: string): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
}

function normalizeSource(value: unknown): LangchainMemorySource | null {
  if (
    value === "memory" ||
    value === "sessions" ||
    value === "repo" ||
    value === "docs" ||
    value === "chat" ||
    value === "email"
  ) {
    return value;
  }
  return null;
}

function normalizeSourceList(values: unknown): LangchainMemorySource[] {
  if (!Array.isArray(values)) {
    return [...DEFAULT_SOURCES];
  }
  const normalized = values
    .map((entry) => normalizeSource(entry))
    .filter((entry): entry is LangchainMemorySource => entry !== null);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : [...DEFAULT_SOURCES];
}

function normalizeStringList(values: unknown, baseDir: string): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const normalized = values
    .map((entry) => normalizeString(entry))
    .filter(Boolean)
    .map((entry) => resolvePathLike(entry, baseDir));
  return Array.from(new Set(normalized));
}

function normalizeScope(value: unknown): LangchainMemoryScope {
  if (value === "global" || value === "session" || value === "prefer_session") {
    return value;
  }
  return "prefer_session";
}

function resolveAgentMemorySearchConfig(
  cfg: OpenClawConfig,
  agentId: string,
): MemorySearchConfig | undefined {
  const defaults = cfg.agents?.defaults?.memorySearch;
  const agent = (cfg.agents?.list ?? []).find((entry) => entry.id === agentId);
  const override = agent?.memorySearch;
  if (!defaults && !override) {
    return undefined;
  }
  return {
    ...(defaults ?? {}),
    ...(override ?? {}),
    query: {
      ...(defaults?.query ?? {}),
      ...(override?.query ?? {}),
    },
  };
}

function resolveLangchainPluginStorageStateInternal(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): LangchainPluginStorageState {
  const stateDir = resolveStateDir(params.env ?? process.env, os.homedir);
  const env = params.env ?? process.env;
  const raw = (params.cfg.plugins?.entries?.[LANGCHAIN_MEMORY_PLUGIN_ID]?.config ?? {}) as Record<
    string,
    unknown
  >;

  const defaultQueueDir = path.join(stateDir, "memory", "langchain", "queue");
  const queueDir = resolvePathLike(
    normalizeString(raw.queueDir, defaultQueueDir),
    path.dirname(defaultQueueDir),
  );
  const baseDir = path.dirname(queueDir);

  return {
    chromaUrl: normalizeString(
      raw.chromaUrl,
      normalizeString(env.OPENCLAW_CHROMA_URL, DEFAULT_CHROMA_URL),
    ),
    collectionPrefix: normalizeString(raw.collectionPrefix, "openclaw"),
    embeddingProvider: normalizeString(raw.embeddingProvider, "openai").toLowerCase(),
    embeddingModel: normalizeString(raw.embeddingModel, "text-embedding-3-small"),
    chunkSize: clampInt(raw.chunkSize, 900, 100, 8000),
    chunkOverlap: clampInt(raw.chunkOverlap, 150, 0, 2000),
    batchSize: clampInt(raw.batchSize, 32, 1, 256),
    syncIntervalSec: clampInt(raw.syncIntervalSec, 300, 0, 86400),
    queueDir,
    baseDir,
    documentsDir: path.join(baseDir, "documents"),
    pendingDir: path.join(queueDir, "pending"),
    statusPath: path.join(baseDir, "status.json"),
    manifestPath: path.join(baseDir, "manifest.json"),
    logsPath: path.join(baseDir, "events.jsonl"),
  };
}

export function resolveLangchainPluginStorageState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): LangchainPluginStorageState {
  return resolveLangchainPluginStorageStateInternal(params);
}

export async function resolveLangchainPluginConfig(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
}): Promise<LangchainPluginConfig> {
  const raw = (params.cfg.plugins?.entries?.[LANGCHAIN_MEMORY_PLUGIN_ID]?.config ?? {}) as Record<
    string,
    unknown
  >;
  const storage = resolveLangchainPluginStorageStateInternal(params);
  const env = params.env ?? process.env;

  const apiKeyResolution = await resolveConfiguredSecretInputWithFallback({
    config: params.cfg,
    env,
    value: raw.apiKeySecretRef,
    path: `plugins.entries.${LANGCHAIN_MEMORY_PLUGIN_ID}.config.apiKeySecretRef`,
    unresolvedReasonStyle: "detailed",
    readFallback: () => {
      const provider = normalizeString(raw.embeddingProvider, "openai").toLowerCase();
      if (provider === "openai") {
        return env.OPENAI_API_KEY?.trim() || undefined;
      }
      if (provider === "openrouter") {
        return env.OPENROUTER_API_KEY?.trim() || undefined;
      }
      return undefined;
    },
  });

  if (apiKeyResolution.unresolvedRefReason) {
    params.logger?.warn?.(apiKeyResolution.unresolvedRefReason);
  }

  return {
    ...storage,
    apiKey: apiKeyResolution.value,
    apiKeyConfigured:
      apiKeyResolution.secretRefConfigured || typeof apiKeyResolution.value === "string",
    apiKeyUnresolvedReason: apiKeyResolution.unresolvedRefReason,
  };
}

export function resolveLangchainAgentConfig(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
}): LangchainAgentConfig {
  const resolved = resolveAgentMemorySearchConfig(params.cfg, params.agentId);
  const workspaceDir = path.resolve(params.workspaceDir);
  const roots = (() => {
    const configuredRoots = normalizeStringList(resolved?.roots, workspaceDir);
    if (configuredRoots.length > 0) {
      return configuredRoots;
    }
    return [workspaceDir];
  })();
  return {
    agentId: params.agentId,
    workspaceDir,
    sources: normalizeSourceList(resolved?.sources),
    roots,
    extraPaths: normalizeStringList(resolved?.extraPaths, workspaceDir),
    scope: normalizeScope(resolved?.query?.scope),
    maxResults: clampInt(resolved?.query?.maxResults, 6, 1, 100),
    minScore:
      typeof resolved?.query?.minScore === "number" && Number.isFinite(resolved.query.minScore)
        ? Math.min(1, Math.max(0, resolved.query.minScore))
        : 0,
  };
}

export function resolveLangchainCollectionName(params: {
  collectionPrefix: string;
  agentId: string;
  domain?: LangchainMemoryDomain;
}): string {
  const suffix =
    params.domain === "user_memory"
      ? "user-memory"
      : params.domain === "docs_kb"
        ? "docs-kb"
        : params.domain === "history"
          ? "history"
          : "";
  const slug = `${params.collectionPrefix}-${params.agentId}${suffix ? `-${suffix}` : ""}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `${LANGCHAIN_MEMORY_PLUGIN_ID}-${params.agentId}`;
}

export function makeStableId(parts: Array<string | number | null | undefined>): string {
  const joined = parts.map((value) => String(value ?? "")).join("::");
  return crypto.createHash("sha256").update(joined).digest("hex");
}

export function buildVirtualDocumentPath(source: LangchainMemorySource, fileName: string): string {
  return path.posix.join(LANGCHAIN_VIRTUAL_ROOT, source, fileName);
}

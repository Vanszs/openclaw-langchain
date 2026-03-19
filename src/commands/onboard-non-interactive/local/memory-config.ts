import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import {
  applyMemoryConfig,
  parseDelimitedList,
  parseMemorySourceList,
} from "../../memory-config-shared.js";
import type { OnboardOptions } from "../../onboard-types.js";

function hasAnyMemoryFlag(opts: OnboardOptions): boolean {
  return Boolean(
    opts.memoryBackend ||
    opts.memoryChromaUrl ||
    opts.memoryCollectionPrefix ||
    opts.memoryEmbeddingProvider ||
    opts.memoryEmbeddingModel ||
    opts.memoryApiKeySecretRef ||
    opts.memorySources ||
    opts.memoryRoots ||
    opts.memoryExtraPaths ||
    opts.memoryScope,
  );
}

export function applyNonInteractiveMemoryConfig(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
  workspaceDir: string;
  runtime: RuntimeEnv;
}): OpenClawConfig | null {
  const { nextConfig, opts, runtime, workspaceDir } = params;
  if (!hasAnyMemoryFlag(opts)) {
    return nextConfig;
  }

  const backend = opts.memoryBackend ?? "memory-langchain";
  if (backend !== "memory-core" && backend !== "memory-langchain" && backend !== "none") {
    runtime.error('Invalid --memory-backend. Use "memory-core", "memory-langchain", or "none".');
    runtime.exit(1);
    return null;
  }

  const embeddingProvider = opts.memoryEmbeddingProvider?.trim() || "openai";
  if (backend === "memory-langchain" && embeddingProvider !== "openai") {
    runtime.error(
      `memory-langchain non-interactive setup currently supports only --memory-embedding-provider openai (received "${embeddingProvider}").`,
    );
    runtime.exit(1);
    return null;
  }

  const scope = opts.memoryScope ?? "prefer_session";
  if (scope !== "global" && scope !== "session" && scope !== "prefer_session") {
    runtime.error('Invalid --memory-scope. Use "global", "session", or "prefer_session".');
    runtime.exit(1);
    return null;
  }

  return applyMemoryConfig(nextConfig, {
    backend,
    workspaceDir,
    chromaUrl: opts.memoryChromaUrl?.trim() || undefined,
    collectionPrefix: opts.memoryCollectionPrefix?.trim() || undefined,
    embeddingProvider,
    embeddingModel: opts.memoryEmbeddingModel?.trim() || undefined,
    apiKeySecretRef: opts.memoryApiKeySecretRef?.trim() || undefined,
    sources: opts.memorySources ? parseMemorySourceList(opts.memorySources) : undefined,
    roots: opts.memoryRoots ? parseDelimitedList(opts.memoryRoots) : undefined,
    extraPaths: opts.memoryExtraPaths ? parseDelimitedList(opts.memoryExtraPaths) : undefined,
    scope,
  });
}

export function hasNonInteractiveMemoryConfig(opts: OnboardOptions): boolean {
  return hasAnyMemoryFlag(opts);
}

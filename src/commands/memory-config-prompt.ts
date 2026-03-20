import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  applyMemoryConfig,
  parseDelimitedList,
  parseMemorySourceList,
  type MemoryBackendSelection,
  type MemoryRecallScope,
} from "./memory-config-shared.js";

type MemoryConfigPrompter = Pick<WizardPrompter, "note" | "select" | "text">;

export async function promptMemoryConfig(
  nextConfig: OpenClawConfig,
  workspaceDir: string,
  prompter: MemoryConfigPrompter,
): Promise<OpenClawConfig> {
  await prompter.note(
    [
      "OpenClaw stays in charge of gateway, channels, sessions, and agent orchestration.",
      "LangChain.js is only used here for ingest, chunking, embeddings, Chroma storage, and retrieval.",
    ].join("\n"),
    "Memory / RAG",
  );

  const currentSlot =
    typeof nextConfig.plugins?.slots?.memory === "string" && nextConfig.plugins.slots.memory.trim()
      ? nextConfig.plugins.slots.memory.trim()
      : "memory-core";
  const currentLangchain = (nextConfig.plugins?.entries?.["memory-langchain"]?.config ??
    {}) satisfies Record<string, unknown>;

  const backend = await prompter.select<MemoryBackendSelection>({
    message: "Memory backend",
    options: [
      {
        value: "memory-core",
        label: "Built-in",
        hint: "Default memory search without LangChain/Chroma",
      },
      {
        value: "memory-langchain",
        label: "LangChain + Chroma",
        hint: "Chunk, embed, and retrieve with Chroma-backed RAG",
      },
      {
        value: "none",
        label: "Disable memory",
        hint: "Turns off memory-slot plugins",
      },
    ],
    initialValue:
      currentSlot === "memory-langchain" || currentSlot === "none" ? currentSlot : "memory-core",
  });

  if (backend === "none") {
    return applyMemoryConfig(nextConfig, {
      backend,
      workspaceDir,
    });
  }

  const embeddingProvider = await prompter.select<string>({
    message: "Embedding provider",
    options: [
      {
        value: "openai",
        label: "OpenAI",
        hint: "Uses OPENAI_API_KEY or configured SecretRef",
      },
      {
        value: "openrouter",
        label: "OpenRouter",
        hint: "Uses OPENROUTER_API_KEY or configured SecretRef",
      },
    ],
    initialValue:
      typeof currentLangchain.embeddingProvider === "string" &&
      currentLangchain.embeddingProvider.trim().toLowerCase() === "openrouter"
        ? "openrouter"
        : "openai",
  });

  const chromaUrl = String(
    (await prompter.text({
      message: "Chroma URL",
      initialValue:
        typeof currentLangchain.chromaUrl === "string"
          ? currentLangchain.chromaUrl
          : "http://127.0.0.1:8000",
    })) ?? "",
  ).trim();

  const collectionPrefix = String(
    (await prompter.text({
      message: "Collection prefix",
      initialValue:
        typeof currentLangchain.collectionPrefix === "string"
          ? currentLangchain.collectionPrefix
          : "openclaw",
    })) ?? "",
  ).trim();

  const embeddingModel = String(
    (await prompter.text({
      message: "Embedding model",
      initialValue:
        typeof currentLangchain.embeddingModel === "string"
          ? currentLangchain.embeddingModel
          : "text-embedding-3-small",
    })) ?? "",
  ).trim();

  const apiKeySecretRef = String(
    (await prompter.text({
      message: "Embedding API key / SecretRef",
      placeholder: "${OPENAI_API_KEY}",
      initialValue:
        typeof currentLangchain.apiKeySecretRef === "string"
          ? currentLangchain.apiKeySecretRef
          : "",
    })) ?? "",
  ).trim();

  const currentMemorySearch = nextConfig.agents?.defaults?.memorySearch;
  const sources = String(
    (await prompter.text({
      message: "Sources to index (comma-separated)",
      initialValue:
        Array.isArray(currentMemorySearch?.sources) && currentMemorySearch.sources.length > 0
          ? currentMemorySearch.sources.join(", ")
          : "memory, repo, docs, chat, email, sessions",
    })) ?? "",
  ).trim();

  const roots = String(
    (await prompter.text({
      message: "Roots to index (comma-separated)",
      initialValue:
        Array.isArray(currentMemorySearch?.roots) && currentMemorySearch.roots.length > 0
          ? currentMemorySearch.roots.join(", ")
          : workspaceDir,
    })) ?? "",
  ).trim();

  const extraPaths = String(
    (await prompter.text({
      message: "Extra paths (optional, comma-separated)",
      initialValue:
        Array.isArray(currentMemorySearch?.extraPaths) && currentMemorySearch.extraPaths.length > 0
          ? currentMemorySearch.extraPaths.join(", ")
          : "",
    })) ?? "",
  ).trim();

  const scope = await prompter.select<MemoryRecallScope>({
    message: "Recall scope",
    options: [
      {
        value: "prefer_session",
        label: "Prefer session",
        hint: "Search current session first, then global knowledge",
      },
      {
        value: "global",
        label: "Global",
        hint: "Search all indexed knowledge together",
      },
      {
        value: "session",
        label: "Session only",
        hint: "Restrict recall to current session context",
      },
    ],
    initialValue:
      currentMemorySearch?.query?.scope === "global" ||
      currentMemorySearch?.query?.scope === "session"
        ? currentMemorySearch.query.scope
        : "prefer_session",
  });

  return applyMemoryConfig(nextConfig, {
    backend,
    workspaceDir,
    chromaUrl: chromaUrl || "http://127.0.0.1:8000",
    collectionPrefix: collectionPrefix || "openclaw",
    embeddingProvider,
    embeddingModel: embeddingModel || "text-embedding-3-small",
    apiKeySecretRef: apiKeySecretRef || undefined,
    sources: parseMemorySourceList(sources),
    roots: parseDelimitedList(roots),
    extraPaths: parseDelimitedList(extraPaths),
    scope,
  });
}

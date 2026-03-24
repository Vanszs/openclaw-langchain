import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  applyMemoryConfig,
  resolveConfiguredChromaUrl,
  findInvalidMemorySources,
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
      "OpenClaw owns memory orchestration, source selection, recall behavior, and memory-tool integration.",
      "Choose whether OpenClaw should use its built-in backend, delegate indexing to LangChain + Chroma, or disable memory.",
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
        label: "Built-in (OpenClaw)",
        hint: "OpenClaw handles indexing, storage, and retrieval itself",
      },
      {
        value: "memory-langchain",
        label: "LangChain + Chroma",
        hint: "OpenClaw orchestrates memory; LangChain + Chroma handle chunking and vector retrieval",
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

  const currentMemorySearch = nextConfig.agents?.defaults?.memorySearch;
  if (backend === "memory-core") {
    await prompter.note(
      [
        "OpenClaw will handle indexing, storage, and retrieval with the built-in memory backend.",
        "The next prompts configure what OpenClaw indexes and how recall behaves.",
      ].join("\n"),
      "Built-in Memory",
    );
  } else {
    await prompter.note(
      [
        "OpenClaw still handles gateway, channels, sessions, agent orchestration, and memory-tool wiring.",
        "LangChain + Chroma take over chunking, embedding calls, vector storage, and retrieval for indexed content.",
      ].join("\n"),
      "LangChain Memory",
    );
  }

  const sources = String(
    (await prompter.text({
      message: "Sources to index (comma-separated)",
      initialValue:
        Array.isArray(currentMemorySearch?.sources) && currentMemorySearch.sources.length > 0
          ? currentMemorySearch.sources.join(", ")
          : "memory, repo, docs, chat, email, sessions",
      validate: (value) => {
        const invalid = findInvalidMemorySources(value);
        return invalid.length > 0
          ? `Unknown source(s): ${invalid.join(", ")}. Use memory, sessions, repo, docs, chat, email.`
          : undefined;
      },
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

  if (backend === "memory-core") {
    return applyMemoryConfig(nextConfig, {
      backend,
      workspaceDir,
      sources: parseMemorySourceList(sources),
      roots: parseDelimitedList(roots),
      extraPaths: parseDelimitedList(extraPaths),
      scope,
    });
  }

  await prompter.note(
    [
      "The remaining prompts configure the LangChain backend itself.",
      "These settings control embeddings, Chroma storage, and collection naming.",
      "If Chroma URL is already configured, or OPENCLAW_CHROMA_URL is set, the prompt is prefilled from that value so you can preserve the current endpoint.",
    ].join("\n"),
    "LangChain Backend",
  );

  const embeddingProvider = await prompter.select<string>({
    message: "Embedding provider for memory-langchain",
    options: [
      {
        value: "openai",
        label: "OpenAI",
        hint: "Uses OPENAI_API_KEY or configured SecretRef",
      },
      {
        value: "openrouter",
        label: "OpenRouter",
        hint: "Uses OPENROUTER_API_KEY for memory-langchain embeddings",
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
      initialValue: resolveConfiguredChromaUrl(currentLangchain.chromaUrl),
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
      placeholder:
        embeddingProvider === "openrouter" ? "${OPENROUTER_API_KEY}" : "${OPENAI_API_KEY}",
      initialValue:
        typeof currentLangchain.apiKeySecretRef === "string"
          ? currentLangchain.apiKeySecretRef
          : "",
    })) ?? "",
  ).trim();

  return applyMemoryConfig(nextConfig, {
    backend,
    workspaceDir,
    chromaUrl: chromaUrl || undefined,
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

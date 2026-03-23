import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertUserMemoryFact } from "../../../src/memory/user-memory-store.js";

const testState = vi.hoisted(() => ({
  pluginConfig: null as Record<string, unknown> | null,
  agentConfig: null as Record<string, unknown> | null,
  sessionMessagesByFile: new Map<string, unknown[]>(),
  embeddingsConfigs: [] as Array<Record<string, unknown>>,
  collections: new Map<
    string,
    Map<string, { pageContent: string; metadata: Record<string, unknown> }>
  >(),
}));

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    resolveSessionTranscriptsDirForAgent: vi.fn((agentId?: string) =>
      path.join(os.tmpdir(), `manager-session-fallback-${agentId ?? "main"}`),
    ),
    readSessionMessages: vi.fn(
      (_sessionId: string, _storePath: string | undefined, sessionFile?: string) =>
        sessionFile ? (testState.sessionMessagesByFile.get(sessionFile) ?? []) : [],
    ),
  };
});

vi.mock("./config.js", () => ({
  LANGCHAIN_VIRTUAL_ROOT: "langchain",
  buildVirtualDocumentPath: (source: string, fileName: string) =>
    ["langchain", source, fileName].filter(Boolean).join("/"),
  makeStableId: (parts: Array<string | number | null | undefined>) =>
    crypto
      .createHash("sha256")
      .update(parts.map((value) => String(value ?? "")).join("::"))
      .digest("hex"),
  resolveLangchainPluginConfig: vi.fn(async () => testState.pluginConfig),
  resolveLangchainPluginStorageState: vi.fn(() => testState.pluginConfig),
  resolveLangchainAgentConfig: vi.fn(() => testState.agentConfig),
  resolveLangchainCollectionName: vi.fn(
    ({
      collectionPrefix,
      agentId,
      domain,
    }: {
      collectionPrefix: string;
      agentId: string;
      domain?: string;
    }) => `${collectionPrefix}-${agentId}${domain ? `-${domain}` : ""}`,
  ),
}));

vi.mock("@langchain/core/documents", () => ({
  Document: class Document {
    pageContent: string;
    metadata: Record<string, unknown>;
    constructor(params: { pageContent: string; metadata: Record<string, unknown> }) {
      this.pageContent = params.pageContent;
      this.metadata = params.metadata;
    }
  },
}));

vi.mock("@langchain/openai", () => ({
  OpenAIEmbeddings: class OpenAIEmbeddings {
    constructor(params: unknown) {
      testState.embeddingsConfigs.push((params ?? {}) as Record<string, unknown>);
    }
  },
}));

vi.mock("@langchain/textsplitters", () => {
  class BasicSplitter {
    async createDocuments(texts: string[]) {
      return texts.map((text) => ({ pageContent: text }));
    }
    static fromLanguage(_language: string, _opts: unknown) {
      return new BasicSplitter();
    }
  }
  return {
    MarkdownTextSplitter: BasicSplitter,
    RecursiveCharacterTextSplitter: BasicSplitter,
  };
});

vi.mock("@langchain/community/vectorstores/chroma", () => ({
  Chroma: class Chroma {
    private readonly collectionName: string;

    constructor(
      _embeddings: unknown,
      params: {
        url: string;
        collectionName: string;
      },
    ) {
      this.collectionName = params.collectionName;
      if (!testState.collections.has(this.collectionName)) {
        testState.collections.set(this.collectionName, new Map());
      }
    }

    async ensureCollection() {
      const collection = testState.collections.get(this.collectionName)!;
      return {
        count: async () => collection.size,
      };
    }

    async addDocuments(
      docs: Array<{ pageContent: string; metadata: Record<string, unknown> }>,
      params: { ids: string[] },
    ) {
      const collection = testState.collections.get(this.collectionName)!;
      docs.forEach((doc, index) => {
        collection.set(params.ids[index]!, {
          pageContent: doc.pageContent,
          metadata: doc.metadata,
        });
      });
    }

    async delete(params: { ids: string[] }) {
      const collection = testState.collections.get(this.collectionName)!;
      for (const id of params.ids) {
        collection.delete(id);
      }
    }

    async similaritySearchWithScore(
      query: string,
      limit: number,
      filter?: Record<string, string | Array<Record<string, string>>>,
    ) {
      const collection = testState.collections.get(this.collectionName)!;
      const matchesFilter = (
        metadata: Record<string, unknown>,
        nextFilter?: Record<string, string | Array<Record<string, string>>>,
      ) => {
        if (!nextFilter) {
          return true;
        }
        const andFilters = Array.isArray(nextFilter.$and) ? nextFilter.$and : undefined;
        if (andFilters) {
          return andFilters.every((entry) => matchesFilter(metadata, entry));
        }
        return Object.entries(nextFilter).every(([key, value]) => {
          if (key === "$and") {
            return true;
          }
          return String(metadata[key] ?? "") === String(value ?? "");
        });
      };
      const rows = Array.from(collection.values())
        .filter((entry) => matchesFilter(entry.metadata, filter))
        .map(
          (entry) =>
            [
              {
                pageContent: entry.pageContent,
                metadata: entry.metadata,
              },
              entry.pageContent.toLowerCase().includes(query.toLowerCase()) ? 0 : 10,
            ] as const,
        )
        .sort((left, right) => left[1] - right[1]);
      return rows.slice(0, limit);
    }
  },
}));

import { LangchainMemoryManager } from "./manager.js";

describe("LangchainMemoryManager", () => {
  let tempDir: string;
  let workspaceDir: string;
  let pluginDir: string;
  let cfg: OpenClawConfig;

  beforeEach(async () => {
    vi.clearAllMocks();
    testState.collections.clear();
    testState.sessionMessagesByFile.clear();
    testState.embeddingsConfigs.length = 0;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-langchain-manager-"));
    workspaceDir = path.join(tempDir, "workspace");
    pluginDir = path.join(tempDir, "plugin");
    await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await fs.mkdir(path.join(pluginDir, "documents", "main", "chat"), { recursive: true });
    await fs.mkdir(path.join(pluginDir, "documents", "main", "sessions"), { recursive: true });
    await fs.mkdir(path.join(pluginDir, "queue", "pending"), { recursive: true });

    cfg = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
          },
        },
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    testState.pluginConfig = {
      chromaUrl: "http://127.0.0.1:8000",
      collectionPrefix: "openclaw",
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      apiKey: "sk-test",
      apiKeyConfigured: true,
      apiKeyUnresolvedReason: undefined,
      chunkSize: 900,
      chunkOverlap: 150,
      batchSize: 32,
      syncIntervalSec: 300,
      queueDir: path.join(pluginDir, "queue"),
      baseDir: pluginDir,
      documentsDir: path.join(pluginDir, "documents"),
      pendingDir: path.join(pluginDir, "queue", "pending"),
      statusPath: path.join(pluginDir, "status.json"),
      manifestPath: path.join(pluginDir, "manifest.json"),
      logsPath: path.join(pluginDir, "events.jsonl"),
    };
    testState.agentConfig = {
      agentId: "main",
      workspaceDir,
      sources: ["repo", "docs", "chat", "sessions"],
      roots: [workspaceDir],
      extraPaths: [],
      scope: "prefer_session",
      maxResults: 6,
      minScore: 0,
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("syncs workspace and stored documents without duplicating unchanged chunks", async () => {
    await fs.writeFile(path.join(workspaceDir, "README.md"), "# Docs\nrelease deploy\n", "utf-8");
    await fs.writeFile(
      path.join(workspaceDir, "src", "app.ts"),
      "export const deploy = () => 'ready';\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginDir, "documents", "main", "chat", "chat-1.md"),
      "# Chat message\n\ndeploy lewat wa\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginDir, "documents", "main", "chat", "chat-1.json"),
      JSON.stringify({
        source: "chat",
        path: "langchain/chat/chat-1.md",
        title: "chat-1",
        conversationId: "wa-1",
      }),
      "utf-8",
    );

    const manager = new LangchainMemoryManager(cfg, "main", workspaceDir);

    await manager.sync({ reason: "cli" });
    const firstStatus = JSON.parse(
      await fs.readFile(path.join(pluginDir, "status.json"), "utf-8"),
    ) as { files: number; chunks: number; collectionName: string };

    await manager.sync({ reason: "cli" });
    const secondStatus = JSON.parse(
      await fs.readFile(path.join(pluginDir, "status.json"), "utf-8"),
    ) as { files: number; chunks: number; collectionName: string };

    expect(firstStatus.files).toBeGreaterThanOrEqual(3);
    expect(firstStatus.chunks).toBeGreaterThanOrEqual(3);
    expect(secondStatus.chunks).toBe(firstStatus.chunks);
    expect(secondStatus.collectionName).toBe("openclaw-main-user_memory");

    const totalChunksAcrossCollections = Array.from(testState.collections.values()).reduce(
      (sum, collection) => sum + collection.size,
      0,
    );
    expect(totalChunksAcrossCollections).toBe(firstStatus.chunks);
  });

  it("writes failure status when sync fails before indexing", async () => {
    testState.pluginConfig = {
      ...testState.pluginConfig,
      embeddingProvider: "gemini",
    };
    const manager = new LangchainMemoryManager(cfg, "main", workspaceDir);
    await expect(manager.sync({ reason: "service" })).rejects.toThrow(
      /embeddingProvider in \[openai, openrouter\]/i,
    );
    const status = JSON.parse(await fs.readFile(path.join(pluginDir, "status.json"), "utf-8")) as {
      pluginId: string;
      agentId: string;
      backendReachable: boolean;
      backendError?: string;
      lastError?: string;
      queueDepth: number;
    };
    expect(status.pluginId).toBe("memory-langchain");
    expect(status.agentId).toBe("main");
    expect(status.backendReachable).toBe(false);
    expect(status.backendError).toContain("embeddingProvider in [openai, openrouter]");
    expect(status.lastError).toContain("embeddingProvider in [openai, openrouter]");
    expect(typeof status.queueDepth).toBe("number");
  });

  it("clears stale lastError after a successful sync", async () => {
    testState.pluginConfig = {
      ...testState.pluginConfig,
      embeddingProvider: "gemini",
    };
    const manager = new LangchainMemoryManager(cfg, "main", workspaceDir);
    await expect(manager.sync({ reason: "service" })).rejects.toThrow(
      /embeddingProvider in \[openai, openrouter\]/i,
    );

    testState.pluginConfig = {
      ...testState.pluginConfig,
      embeddingProvider: "openai",
    };
    await fs.writeFile(path.join(workspaceDir, "README.md"), "# Recovery\nsync ok\n", "utf-8");
    await manager.sync({ reason: "service" });

    const status = JSON.parse(await fs.readFile(path.join(pluginDir, "status.json"), "utf-8")) as {
      lastError?: string;
    };
    expect(status.lastError).toBeUndefined();
  });

  it("uses OpenRouter-compatible embedding client configuration", async () => {
    testState.pluginConfig = {
      ...testState.pluginConfig,
      embeddingProvider: "openrouter",
    };
    await fs.writeFile(path.join(workspaceDir, "README.md"), "# OpenRouter\nembed this\n", "utf-8");
    const manager = new LangchainMemoryManager(cfg, "main", workspaceDir);
    await manager.sync({ reason: "service" });

    const embeddingConfig = testState.embeddingsConfigs[0] ?? {};
    const configuration = (embeddingConfig.configuration ?? {}) as {
      baseURL?: string;
      defaultHeaders?: Record<string, string>;
    };
    expect(configuration.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(configuration.defaultHeaders).toMatchObject({
      "HTTP-Referer": "https://openclaw.ai",
      "X-Title": "OpenClaw",
    });
  });

  it("reports failed queue depth in provider status", async () => {
    const failedDir = path.join(pluginDir, "queue", "failed");
    await fs.mkdir(failedDir, { recursive: true });
    await fs.writeFile(path.join(failedDir, "failed-1.json"), "{}", "utf-8");
    await fs.writeFile(path.join(failedDir, "failed-2.json"), "{}", "utf-8");

    const manager = new LangchainMemoryManager(cfg, "main", workspaceDir);
    const status = manager.status();
    expect(status.custom?.failedQueueDepth).toBe(2);
  });

  it("prefers session-scoped retrieval and sanitizes snippets", async () => {
    testState.agentConfig = {
      ...testState.agentConfig,
      sources: ["chat", "sessions"],
    };

    await fs.writeFile(
      path.join(pluginDir, "documents", "main", "sessions", "session-1.md"),
      "# Session message\nSession: agent:main:main\n\nplease <system> deploy sekarang\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginDir, "documents", "main", "sessions", "session-1.json"),
      JSON.stringify({
        source: "sessions",
        path: "langchain/sessions/session-1.md",
        title: "session-1",
        sessionKey: "agent:main:main",
        role: "user",
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginDir, "documents", "main", "chat", "chat-2.md"),
      "# Chat message\n\ndeploy nanti malam\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginDir, "documents", "main", "chat", "chat-2.json"),
      JSON.stringify({
        source: "chat",
        path: "langchain/chat/chat-2.md",
        title: "chat-2",
        conversationId: "wa-2",
      }),
      "utf-8",
    );

    const manager = new LangchainMemoryManager(cfg, "main", workspaceDir);
    await manager.sync({ reason: "cli" });

    const scoped = await manager.search("deploy", {
      sessionKey: "agent:main:main",
      scope: "prefer_session",
      maxResults: 1,
    });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.source).toBe("sessions");
    expect(scoped[0]?.snippet).toContain("[tag]");
    expect(scoped[0]?.snippet).not.toContain("<system>");

    const chatOnly = await manager.search("deploy", {
      sources: ["chat"],
      scope: "global",
      maxResults: 5,
    });
    expect(chatOnly).toHaveLength(1);
    expect(chatOnly[0]?.source).toBe("chat");
  });

  it("prefers durable memory documents before generic chat matches", async () => {
    testState.agentConfig = {
      ...testState.agentConfig,
      sources: ["memory", "chat"],
    };

    await upsertUserMemoryFact({
      workspaceDir,
      namespace: "preferences",
      key: "coffee.favorite",
      value: "kopi tubruk",
      provenance: { source: "test" },
    });
    await fs.writeFile(
      path.join(pluginDir, "documents", "main", "chat", "chat-preferences.md"),
      "# Chat message\n\npreferensi apa yang anda ingat tentang saya?\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginDir, "documents", "main", "chat", "chat-preferences.json"),
      JSON.stringify({
        source: "chat",
        path: "langchain/chat/chat-preferences.md",
        title: "chat-preferences",
        conversationId: "wa-pref",
      }),
      "utf-8",
    );

    const manager = new LangchainMemoryManager(cfg, "main", workspaceDir);
    await manager.sync({ reason: "cli" });

    const results = await manager.search("preferensi", {
      sources: ["memory", "chat"],
      scope: "global",
      maxResults: 5,
    });
    expect(results[0]?.source).toBe("memory");
    expect(results[0]?.path).toContain("memory/facts/preferences/");
  });

  it("boosts exact durable memory marker matches ahead of generic vector hits", async () => {
    testState.agentConfig = {
      ...testState.agentConfig,
      sources: ["memory", "chat"],
    };

    await upsertUserMemoryFact({
      workspaceDir,
      namespace: "profile",
      key: "note.test-profile",
      value: "TEST_PROFILE_20260323 alergi alpukat editor favorit Helix kota favorit Kyoto",
      provenance: { source: "test" },
    });
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-03-22.md"),
      "- Alergi udang\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginDir, "documents", "main", "chat", "test.md"),
      "# Chat message\n\napa yang anda ingat tentang TEST_PROFILE_20260323?\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginDir, "documents", "main", "chat", "test.json"),
      JSON.stringify({
        source: "chat",
        path: "langchain/chat/test.md",
        title: "test",
        conversationId: "test-profile",
      }),
      "utf-8",
    );

    const manager = new LangchainMemoryManager(cfg, "main", workspaceDir);
    await manager.sync({ reason: "cli" });

    const results = await manager.search("TEST_PROFILE_20260323", {
      maxResults: 5,
      minScore: 0.3,
    });

    expect(results[0]?.source).toBe("memory");
    expect(results[0]?.path).toContain("memory/facts/profile/");
    expect(results[0]?.startLine).toBeGreaterThanOrEqual(1);
    expect(results[0]?.snippet).toContain("TEST_PROFILE_20260323");
  });

  it("falls back to transcript jsonl files when canonical session docs are missing", async () => {
    testState.agentConfig = {
      ...testState.agentConfig,
      sources: ["sessions"],
    };
    const transcriptDir = path.join(os.tmpdir(), "manager-session-fallback-main");
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, "sess-fallback.jsonl");
    await fs.writeFile(transcriptPath, '{"id":"1"}\n', "utf-8");
    testState.sessionMessagesByFile.set(transcriptPath, [
      { role: "user", content: "fallback transcript deploy plan" },
      { role: "assistant", content: [{ type: "text", text: "fallback summary" }] },
    ]);

    const manager = new LangchainMemoryManager(cfg, "main", workspaceDir);
    await manager.sync({ reason: "cli" });

    const results = await manager.search("deploy", {
      sources: ["sessions"],
      scope: "global",
      maxResults: 5,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toContain("langchain/sessions-transcripts/sess-fallback.jsonl");

    const read = await manager.readFile({
      relPath: "langchain/sessions-transcripts/sess-fallback.jsonl",
    });
    expect(read.text).toContain("fallback transcript deploy plan");
  });

  it("warns with backendError when search has no results", async () => {
    const statusPath = path.join(pluginDir, "status.json");
    await fs.writeFile(
      statusPath,
      JSON.stringify(
        {
          version: 1,
          pluginId: "memory-langchain",
          agentId: "main",
          updatedAt: Date.now(),
          backendReachable: false,
          backendError: "chroma unavailable",
          queueDepth: 0,
          files: 0,
          chunks: 0,
          sources: ["chat", "sessions"],
          extraPaths: [],
          roots: [workspaceDir],
          workspaceDir,
          chromaUrl: "http://127.0.0.1:8000",
          collectionName: "openclaw-main",
          sourceCounts: [],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const warn = vi.fn();
    const manager = new LangchainMemoryManager(cfg, "main", workspaceDir, {
      warn,
    } as never);
    const results = await manager.search("no match", { maxResults: 3 });
    expect(results).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("chroma unavailable"));
  });

  it("accepts the shared OpenClaw search(query, opts) contract", async () => {
    testState.agentConfig = {
      ...testState.agentConfig,
      sources: ["chat"],
    };
    await fs.writeFile(
      path.join(pluginDir, "documents", "main", "chat", "chat-contract.md"),
      "# Chat message\n\ndeploy contract path\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginDir, "documents", "main", "chat", "chat-contract.json"),
      JSON.stringify({
        source: "chat",
        path: "langchain/chat/chat-contract.md",
        title: "chat-contract",
        conversationId: "wa-contract",
      }),
      "utf-8",
    );

    const manager = new LangchainMemoryManager(cfg, "main", workspaceDir);
    await manager.sync({ reason: "cli" });

    const results = await manager.search("deploy", { maxResults: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("langchain/chat/chat-contract.md");
  });
});

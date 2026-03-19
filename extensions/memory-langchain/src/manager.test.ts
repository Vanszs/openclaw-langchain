import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  pluginConfig: null as Record<string, unknown> | null,
  agentConfig: null as Record<string, unknown> | null,
  sessionMessagesByFile: new Map<string, unknown[]>(),
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
    ({ collectionPrefix, agentId }: { collectionPrefix: string; agentId: string }) =>
      `${collectionPrefix}-${agentId}`,
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
    constructor(_params: unknown) {}
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

    async similaritySearchWithScore(query: string, limit: number, filter?: Record<string, string>) {
      const collection = testState.collections.get(this.collectionName)!;
      const rows = Array.from(collection.values())
        .filter((entry) => {
          if (!filter) {
            return true;
          }
          return Object.entries(filter).every(
            ([key, value]) => String(entry.metadata[key] ?? "") === value,
          );
        })
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
    expect(secondStatus.collectionName).toBe("openclaw-main");

    const collection = testState.collections.get("openclaw-main");
    expect(collection?.size).toBe(firstStatus.chunks);
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

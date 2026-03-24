import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/agent-scope.js", () => ({
  resolveSessionAgentId: vi.fn().mockReturnValue("main"),
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig: vi.fn().mockReturnValue({ enabled: true }),
}));

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager: vi.fn(),
}));

import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { getMemorySearchManager } from "../memory/index.js";
import {
  buildDeterministicMemoryRecallContext,
  shouldInjectDeterministicMemoryRecall,
} from "./memory-recall.js";

describe("memory recall deterministic routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveMemorySearchConfig).mockReturnValue({ enabled: true } as never);
  });

  it("matches explicit memory/RAG recall questions", () => {
    expect(shouldInjectDeterministicMemoryRecall("cek chroma db")).toBe(true);
    expect(shouldInjectDeterministicMemoryRecall("is memory working")).toBe(true);
    expect(shouldInjectDeterministicMemoryRecall("who am i?")).toBe(true);
    expect(shouldInjectDeterministicMemoryRecall("apa yang kamu tahu tentang aku?")).toBe(true);
    expect(
      shouldInjectDeterministicMemoryRecall(
        "informasi apa yg anda punya di rag chroma db tentang saya?",
      ),
    ).toBe(true);
    expect(
      shouldInjectDeterministicMemoryRecall(
        "Gunakan tool memory_search untuk mencari informasi tentang saya.",
      ),
    ).toBe(true);
    expect(shouldInjectDeterministicMemoryRecall("cari docs OpenClaw tentang gateway token")).toBe(
      true,
    );
    expect(shouldInjectDeterministicMemoryRecall("kemarin saya bilang apa tentang DuckDB?")).toBe(
      true,
    );
  });

  it("does not match memory save requests or generic system phrasing", () => {
    expect(
      shouldInjectDeterministicMemoryRecall("simpan informasi yang menurut anda penting di rag"),
    ).toBe(false);
    expect(shouldInjectDeterministicMemoryRecall("why is memory usage high?")).toBe(false);
    expect(shouldInjectDeterministicMemoryRecall("how do I create an index in sqlite?")).toBe(
      false,
    );
    expect(shouldInjectDeterministicMemoryRecall("show the previous error")).toBe(false);
  });

  it("returns retrieved user_memory snippets when search succeeds", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search: vi.fn().mockResolvedValue([
          {
            path: "memory/facts/preferences/framework-favorite.json",
            startLine: 1,
            endLine: 2,
            score: 0.4012,
            snippet: "- Alergi udang\n- Database favorit: DuckDB",
            source: "memory",
            domain: "user_memory",
          },
        ]),
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          sources: ["memory", "chat"],
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn(),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
        SenderUsername: "belugaa",
      },
      cfg: { agents: { defaults: {} } },
      query: "informasi apa yg anda punya di rag chroma db tentang saya?",
    });

    expect(result?.domain).toBe("user_memory");
    expect(result?.note).toContain("Retrieved context");
    expect(result?.note).toContain("Domain: user_memory");
    expect(result?.note).toContain("Retrieval status: ok (1 result)");
    expect(result?.note).toContain("Provider: langchain");
    expect(result?.note).toContain("Database favorit: DuckDB");
    expect(result?.systemPromptHint).toContain("Deterministic user-memory recall already ran");
  });

  it("routes docs/reference questions to docs_kb retrieval", async () => {
    const search = vi.fn().mockResolvedValue([
      {
        path: "docs/gateway/configuration.md",
        startLine: 10,
        endLine: 12,
        score: 0.51,
        snippet: "Gateway token: shared auth for the Gateway + Control UI.",
        source: "docs",
        domain: "docs_kb",
      },
    ]);
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search,
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          sources: ["docs", "repo"],
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn(),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "cari docs OpenClaw tentang gateway token",
    });

    expect(result?.domain).toBe("docs_kb");
    expect(search).toHaveBeenCalledWith(
      "cari docs OpenClaw tentang gateway token",
      expect.objectContaining({
        domain: "docs_kb",
        sources: ["docs", "repo"],
      }),
    );
    expect(result?.note).toContain("Domain: docs_kb");
    expect(result?.note).toContain("Gateway token: shared auth");
  });

  it("routes transcript questions to history retrieval", async () => {
    const search = vi.fn().mockResolvedValue([
      {
        path: "langchain/sessions/test.md",
        startLine: 3,
        endLine: 4,
        score: 0.44,
        snippet: "## user\nSaya suka DuckDB",
        source: "sessions",
        domain: "history",
      },
    ]);
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search,
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          sources: ["sessions"],
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn(),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "kemarin saya bilang apa tentang DuckDB?",
    });

    expect(result?.domain).toBe("history");
    expect(search).toHaveBeenCalledWith(
      "saya bilang apa tentang DuckDB?",
      expect.objectContaining({
        domain: "history",
        sources: ["chat", "email", "sessions"],
      }),
    );
    expect(result?.note).toContain("Domain: history");
  });

  it("returns live backend status for chroma health questions", async () => {
    const status = {
      backend: "plugin",
      provider: "langchain",
      model: "text-embedding-3-small",
      dbPath: "http://127.0.0.1:8889",
      vector: { enabled: true, available: false },
      custom: {
        collectionName: "openclaw-main-user-memory",
        backendError: "stale cached error",
      },
    };
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search: vi.fn(),
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue(status),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn().mockResolvedValue(true),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "cek chroma db",
    });

    expect(result?.note).toContain("Deterministic route: memory-backend-status");
    expect(result?.note).toContain("Retrieval status: backend-ready");
    expect(result?.note).toContain("Vector probe: ok");
    expect(result?.note).toContain("Store: http://127.0.0.1:8889");
    expect(result?.note).not.toContain("stale cached error");
    expect(result?.systemPromptHint).toContain(
      "Deterministic memory backend status probing already ran",
    );
  });

  it("reports per-domain partial backend health when one collection probe fails", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search: vi.fn(),
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          dbPath: "http://127.0.0.1:8889",
          vector: { enabled: true, available: false },
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn().mockResolvedValue(false),
        probeVectorStatus: vi.fn().mockResolvedValue({
          available: false,
          error: "history collection unavailable",
          domains: {
            user_memory: {
              domain: "user_memory",
              available: true,
              collection: "openclaw-main-user-memory",
            },
            docs_kb: {
              domain: "docs_kb",
              available: true,
              collection: "openclaw-main-docs-kb",
            },
            history: {
              domain: "history",
              available: false,
              collection: "openclaw-main-history",
              error: "history collection unavailable",
            },
          },
        }),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "status chroma db",
    });

    expect(result?.note).toContain("Retrieval status: backend-partial");
    expect(result?.note).toContain("Vector probe: partial");
    expect(result?.note).toContain("- history: failed | collection=openclaw-main-history");
    expect(result?.note).toContain("Backend error: history collection unavailable");
  });

  it("reports backend-unavailable when the live vector probe fails", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search: vi.fn(),
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          dbPath: "http://127.0.0.1:8889",
          vector: { enabled: true, available: false },
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "status chroma db",
    });

    expect(result?.note).toContain("Retrieval status: backend-unavailable");
    expect(result?.note).toContain("Vector probe: failed");
    expect(result?.note).toContain("Backend error: connect ECONNREFUSED");
  });

  it("returns unavailable context when backend is unavailable", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: null,
      error: "Chroma connection refused",
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "apa isi rag chroma saya?",
    });

    expect(result?.note).toContain("Retrieval status: unavailable");
    expect(result?.note).toContain("Backend error: Chroma connection refused");
  });

  it("returns no-match context when recall finds nothing", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search: vi.fn().mockResolvedValue([]),
        readFile: vi.fn(),
        status: vi.fn().mockReturnValue({
          backend: "plugin",
          provider: "langchain",
          model: "text-embedding-3-small",
          sources: ["memory"],
        }),
        probeEmbeddingAvailability: vi.fn(),
        probeVectorAvailability: vi.fn(),
      },
    });

    const result = await buildDeterministicMemoryRecallContext({
      ctx: {
        SessionKey: "agent:main:telegram:direct:123",
      },
      cfg: { agents: { defaults: {} } },
      query: "what do you have in memory about me?",
    });

    expect(result?.note).toContain("Retrieval status: no matches");
    expect(result?.note).toContain("Results: none");
  });
});

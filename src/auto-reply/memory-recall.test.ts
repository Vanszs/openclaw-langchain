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

  it("does not match memory save requests", () => {
    expect(
      shouldInjectDeterministicMemoryRecall("simpan informasi yang menurut anda penting di rag"),
    ).toBe(false);
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
      "cari OpenClaw tentang gateway token",
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

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
  });

  it("does not match memory save requests", () => {
    expect(
      shouldInjectDeterministicMemoryRecall("simpan informasi yang menurut anda penting di rag"),
    ).toBe(false);
  });

  it("returns retrieved memory snippets when search succeeds", async () => {
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search: vi.fn().mockResolvedValue([
          {
            path: "memory/2026-03-23.md",
            startLine: 1,
            endLine: 2,
            score: 0.4012,
            snippet: "- Alergi udang\n- Database favorit: DuckDB",
            source: "memory",
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

    expect(result?.note).toContain("Retrieved memory recall context");
    expect(result?.note).toContain("Retrieval status: ok (1 result)");
    expect(result?.note).toContain("Provider: langchain");
    expect(result?.note).toContain("Database favorit: DuckDB");
    expect(result?.systemPromptHint).toContain("Deterministic memory recall already ran");
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

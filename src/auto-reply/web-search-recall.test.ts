import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../web-search/runtime.js", () => ({
  runWebSearch: vi.fn(),
}));

import { runWebSearch } from "../web-search/runtime.js";
import {
  buildDeterministicWebSearchContext,
  shouldInjectDeterministicWebSearch,
} from "./web-search-recall.js";

describe("web search deterministic routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches freshness-sensitive current-info questions", () => {
    expect(shouldInjectDeterministicWebSearch("berapa versi Next.js terbaru?")).toBe(true);
    expect(shouldInjectDeterministicWebSearch("cari informasi docs OpenClaw terbaru")).toBe(true);
    expect(
      shouldInjectDeterministicWebSearch("apa yang anda punya di rag chroma tentang saya"),
    ).toBe(false);
  });

  it("returns retrieved web-search context when search succeeds", async () => {
    vi.mocked(runWebSearch).mockResolvedValue({
      provider: "perplexity",
      result: {
        content: "Next.js latest stable release is 16.0.0.",
        citations: ["https://nextjs.org/blog"],
      },
    });

    const result = await buildDeterministicWebSearchContext({
      cfg: {},
      query: "berapa versi Next.js terbaru?",
    });

    expect(result?.domain).toBe("web_search");
    expect(result?.note).toContain("Deterministic route: web-search");
    expect(result?.note).toContain("Domain: web_search");
    expect(result?.note).toContain("Provider: perplexity");
    expect(result?.note).toContain("Next.js latest stable release");
    expect(result?.systemPromptHint).toContain("Deterministic web search already ran");
  });

  it("returns unavailable context on provider errors", async () => {
    vi.mocked(runWebSearch).mockResolvedValue({
      provider: "perplexity",
      result: {
        error: "missing_perplexity_api_key",
        message: "web_search (perplexity) needs an API key.",
      },
    });

    const result = await buildDeterministicWebSearchContext({
      cfg: {},
      query: "cari informasi docs OpenClaw terbaru",
    });

    expect(result?.note).toContain("Retrieval status: unavailable");
    expect(result?.note).toContain("Backend error: web_search (perplexity) needs an API key.");
  });
});

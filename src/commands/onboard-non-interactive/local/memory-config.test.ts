import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { applyNonInteractiveMemoryConfig } from "./memory-config.js";

function createRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("applyNonInteractiveMemoryConfig", () => {
  it("defaults generic memory flags to the built-in backend", () => {
    const runtime = createRuntime();
    const nextConfig: OpenClawConfig = {
      plugins: {
        entries: {
          "memory-langchain": {
            enabled: true,
            config: {
              chromaUrl: "http://127.0.0.1:8000",
            },
          },
        },
      },
    };

    const result = applyNonInteractiveMemoryConfig({
      nextConfig,
      opts: {
        memorySources: "memory, repo, docs",
        memoryRoots: "/workspace",
        memoryScope: "global",
      },
      workspaceDir: "/workspace",
      runtime,
    });

    expect(result?.plugins?.slots?.memory).toBe("memory-core");
    expect(result?.plugins?.entries?.["memory-langchain"]?.enabled).toBe(false);
    expect(result?.agents?.defaults?.memorySearch).toMatchObject({
      sources: ["memory", "repo", "docs"],
      roots: ["/workspace"],
      query: { scope: "global" },
    });
  });

  it("defaults langchain-specific flags to the langchain backend", () => {
    const runtime = createRuntime();
    const nextConfig: OpenClawConfig = {};

    const result = applyNonInteractiveMemoryConfig({
      nextConfig,
      opts: {
        memoryChromaUrl: "http://127.0.0.1:8000",
        memoryEmbeddingProvider: "openrouter",
      },
      workspaceDir: "/workspace",
      runtime,
    });

    expect(result?.plugins?.slots?.memory).toBe("memory-langchain");
    expect(result?.plugins?.entries?.["memory-langchain"]?.config).toMatchObject({
      chromaUrl: "http://127.0.0.1:8000",
      embeddingProvider: "openrouter",
    });
  });

  it("rejects invalid memory source tokens", () => {
    const runtime = createRuntime();
    const result = applyNonInteractiveMemoryConfig({
      nextConfig: {},
      opts: {
        memorySources: "memory, repoo",
      },
      workspaceDir: "/workspace",
      runtime,
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(
      "Invalid --memory-sources entries: repoo. Use memory, sessions, repo, docs, chat, email.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

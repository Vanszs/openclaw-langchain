import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { promptMemoryConfig } from "./memory-config-prompt.js";

function createPrompter(params: {
  selectValues: unknown[];
  textValues?: string[];
}): Pick<WizardPrompter, "note" | "select" | "text"> {
  const selectValues = [...params.selectValues];
  const textValues = [...(params.textValues ?? [])];
  return {
    note: vi.fn(async () => {}),
    select: vi.fn(async () => selectValues.shift()) as unknown as WizardPrompter["select"],
    text: vi.fn(async () => textValues.shift() ?? "") as WizardPrompter["text"],
  };
}

describe("promptMemoryConfig", () => {
  it("configures the langchain memory slot and memorySearch defaults", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          memorySearch: {
            sources: ["memory"],
          },
        },
      },
    };
    const prompter = createPrompter({
      selectValues: ["memory-langchain", "global"],
      textValues: [
        "http://127.0.0.1:8000",
        "openclaw",
        "text-embedding-3-small",
        "${OPENAI_API_KEY}",
        "repo, docs, sessions",
        "/workspace/app, /workspace/docs",
        "/workspace/mail",
      ],
    });

    const result = await promptMemoryConfig(cfg, "/workspace", prompter);

    expect(result.plugins?.slots?.memory).toBe("memory-langchain");
    expect(result.plugins?.entries?.["memory-langchain"]).toMatchObject({
      enabled: true,
      config: {
        chromaUrl: "http://127.0.0.1:8000",
        collectionPrefix: "openclaw",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        apiKeySecretRef: "${OPENAI_API_KEY}",
      },
    });
    expect(result.agents?.defaults?.memorySearch).toMatchObject({
      sources: ["repo", "docs", "sessions"],
      roots: ["/workspace/app", "/workspace/docs"],
      extraPaths: ["/workspace/mail"],
      query: { scope: "global" },
    });
  });

  it("can disable memory plugins entirely", async () => {
    const cfg: OpenClawConfig = {
      plugins: {
        slots: {
          memory: "memory-core",
        },
      },
    };
    const prompter = createPrompter({
      selectValues: ["none"],
    });

    const result = await promptMemoryConfig(cfg, "/workspace", prompter);

    expect(result.plugins?.slots?.memory).toBe("none");
  });
});

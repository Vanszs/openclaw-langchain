import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLangchainPluginConfig } from "./config.js";

describe("resolveLangchainPluginConfig", () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;

  afterEach(() => {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
    if (originalOpenRouterKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    }
  });

  it("uses the injected env fallback for openrouter api keys", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const cfg = {
      plugins: {
        entries: {
          "memory-langchain": {
            config: {
              embeddingProvider: "openrouter",
            },
          },
        },
      },
    } as OpenClawConfig;

    const resolved = await resolveLangchainPluginConfig({
      cfg,
      env: {
        OPENROUTER_API_KEY: "sk-openrouter-from-env",
      } as NodeJS.ProcessEnv,
    });

    expect(resolved.apiKey).toBe("sk-openrouter-from-env");
  });
});

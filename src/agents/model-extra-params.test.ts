import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveModelExtraParams } from "./model-extra-params.js";

describe("resolveModelExtraParams", () => {
  it("provides built-in DeepInfra bf16 routing for the default GPT-OSS model", () => {
    expect(
      resolveModelExtraParams({
        cfg: undefined,
        provider: "openrouter",
        modelId: "openai/gpt-oss-120b",
      }),
    ).toEqual({
      provider: {
        order: ["deepinfra"],
        quantizations: ["bf16"],
        require_parameters: true,
        allow_fallbacks: false,
      },
    });
  });

  it("provides built-in DeepInfra bf16 routing for the default OCR image model", () => {
    expect(
      resolveModelExtraParams({
        cfg: undefined,
        provider: "openrouter",
        modelId: "qwen/qwen-2.5-vl-7b-instruct",
      }),
    ).toEqual({
      provider: {
        order: ["deepinfra"],
        quantizations: ["bf16"],
        require_parameters: true,
        allow_fallbacks: false,
      },
    });
  });

  it("preserves hard-pin routing invariants while merging compatible provider overrides", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openrouter/openai/gpt-oss-120b": {
              params: {
                provider: {
                  order: ["other-provider"],
                  only: ["deepinfra"],
                  allow_fallbacks: true,
                  quantizations: ["fp8"],
                  require_parameters: false,
                },
                temperature: 0.2,
              },
            },
          },
        },
      },
    };

    expect(
      resolveModelExtraParams({
        cfg,
        provider: "openrouter",
        modelId: "openai/gpt-oss-120b",
      }),
    ).toEqual({
      provider: {
        order: ["deepinfra", "other-provider"],
        quantizations: ["bf16", "fp8"],
        require_parameters: true,
        allow_fallbacks: false,
        only: ["deepinfra"],
      },
      temperature: 0.2,
    });
  });
});

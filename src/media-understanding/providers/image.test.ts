import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const completeMock = vi.fn();
const minimaxUnderstandImageMock = vi.fn();
const ensureOpenClawModelsJsonMock = vi.fn(async () => {});
const getApiKeyForModelMock = vi.fn(async () => ({
  apiKey: "oauth-test", // pragma: allowlist secret
  source: "test",
  mode: "oauth",
}));
const resolveApiKeyForProviderMock = vi.fn(async () => ({
  apiKey: "oauth-test", // pragma: allowlist secret
  source: "test",
  mode: "oauth",
}));
const requireApiKeyMock = vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? "");
const setRuntimeApiKeyMock = vi.fn();
const discoverModelsMock = vi.fn();
type ImageModule = typeof import("./image.js");

let describeImageWithModel: ImageModule["describeImageWithModel"];

describe("describeImageWithModel", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@mariozechner/pi-ai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
      return {
        ...actual,
        complete: completeMock,
      };
    });
    vi.doMock("../../agents/minimax-vlm.js", () => ({
      isMinimaxVlmProvider: (provider: string) =>
        provider === "minimax" || provider === "minimax-portal",
      isMinimaxVlmModel: (provider: string, modelId: string) =>
        (provider === "minimax" || provider === "minimax-portal") && modelId === "MiniMax-VL-01",
      minimaxUnderstandImage: minimaxUnderstandImageMock,
    }));
    vi.doMock("../../agents/models-config.js", () => ({
      ensureOpenClawModelsJson: ensureOpenClawModelsJsonMock,
    }));
    vi.doMock("../../agents/model-auth.js", () => ({
      getApiKeyForModel: getApiKeyForModelMock,
      resolveApiKeyForProvider: resolveApiKeyForProviderMock,
      requireApiKey: requireApiKeyMock,
    }));
    vi.doMock("../../agents/pi-model-discovery-runtime.js", () => ({
      discoverAuthStorage: () => ({
        setRuntimeApiKey: setRuntimeApiKeyMock,
      }),
      discoverModels: discoverModelsMock,
    }));
    ({ describeImageWithModel } = await import("./image.js"));
    minimaxUnderstandImageMock.mockResolvedValue("portal ok");
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "minimax-portal",
        id: "MiniMax-VL-01",
        input: ["text", "image"],
        baseUrl: "https://api.minimax.io/anthropic",
      })),
    });
  });

  it("routes minimax-portal image models through the MiniMax VLM endpoint", async () => {
    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "minimax-portal",
      model: "MiniMax-VL-01",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalled();
    expect(getApiKeyForModelMock).toHaveBeenCalled();
    expect(requireApiKeyMock).toHaveBeenCalled();
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("minimax-portal", "oauth-test");
    expect(minimaxUnderstandImageMock).toHaveBeenCalledWith({
      apiKey: "oauth-test", // pragma: allowlist secret
      prompt: "Describe the image.",
      imageDataUrl: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
      modelBaseUrl: "https://api.minimax.io/anthropic",
    });
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("uses generic completion for non-canonical minimax-portal image models", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "minimax-portal",
        id: "custom-vision",
        input: ["text", "image"],
        baseUrl: "https://api.minimax.io/anthropic",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "anthropic-messages",
      provider: "minimax-portal",
      model: "custom-vision",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "generic ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "minimax-portal",
      model: "custom-vision",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "generic ok",
      model: "custom-vision",
    });
    expect(completeMock).toHaveBeenCalledOnce();
    expect(minimaxUnderstandImageMock).not.toHaveBeenCalled();
  });

  it("normalizes deprecated google flash ids before lookup and keeps profile auth selection", async () => {
    const findMock = vi.fn((provider: string, modelId: string) => {
      expect(provider).toBe("google");
      expect(modelId).toBe("gemini-3-flash-preview");
      return {
        provider: "google",
        id: "gemini-3-flash-preview",
        input: ["text", "image"],
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      };
    });
    discoverModelsMock.mockReturnValue({ find: findMock });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      model: "gemini-3-flash-preview",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "flash ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "google",
      model: "gemini-3.1-flash-preview",
      profile: "google:default",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "flash ok",
      model: "gemini-3-flash-preview",
    });
    expect(findMock).toHaveBeenCalledOnce();
    expect(getApiKeyForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "google:default",
      }),
    );
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "oauth-test");
  });

  it("normalizes gemini 3.1 flash-lite ids before lookup and keeps profile auth selection", async () => {
    const findMock = vi.fn((provider: string, modelId: string) => {
      expect(provider).toBe("google");
      expect(modelId).toBe("gemini-3.1-flash-lite-preview");
      return {
        provider: "google",
        id: "gemini-3.1-flash-lite-preview",
        input: ["text", "image"],
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      };
    });
    discoverModelsMock.mockReturnValue({ find: findMock });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      model: "gemini-3.1-flash-lite-preview",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "flash lite ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "google",
      model: "gemini-3.1-flash-lite",
      profile: "google:default",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "flash lite ok",
      model: "gemini-3.1-flash-lite-preview",
    });
    expect(findMock).toHaveBeenCalledOnce();
    expect(getApiKeyForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "google:default",
      }),
    );
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "oauth-test");
  });

  it("injects configured OpenRouter provider routing into image completion payloads", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "openrouter",
        id: "qwen/qwen-2.5-vl-7b-instruct",
        input: ["text", "image"],
        maxTokens: 4096,
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-completions",
      provider: "openrouter",
      model: "qwen/qwen-2.5-vl-7b-instruct",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "ocr ok" }],
    });

    await describeImageWithModel({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openrouter/qwen/qwen-2.5-vl-7b-instruct": {
                params: {
                  provider: {
                    order: ["deepinfra"],
                    allowFallbacks: false,
                    requireParameters: true,
                    quantizations: ["bf16"],
                  },
                },
              },
            },
          },
        },
      },
      agentDir: "/tmp/openclaw-agent",
      provider: "openrouter",
      model: "qwen/qwen-2.5-vl-7b-instruct",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    const options = completeMock.mock.calls[0]?.[2] as
      | { onPayload?: (payload: unknown, model: unknown) => Promise<unknown> }
      | undefined;
    expect(options?.onPayload).toBeTypeOf("function");

    const payload = {};
    const routedPayload = (await options?.onPayload?.(payload, {
      provider: "openrouter",
      id: "qwen/qwen-2.5-vl-7b-instruct",
    })) as Record<string, unknown>;
    expect((routedPayload.provider ?? payload["provider"]) as Record<string, unknown>).toEqual({
      order: ["deepinfra"],
      allow_fallbacks: false,
      require_parameters: true,
      quantizations: ["bf16"],
    });
  });

  it("falls back to models.json provider metadata for configured OpenRouter image models", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-runtime-"));
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      `${JSON.stringify(
        {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/api/v1",
              api: "openai-completions",
              models: [
                {
                  id: "auto",
                  name: "OpenRouter Auto",
                  reasoning: false,
                  input: ["text", "image"],
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  contextWindow: 200000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => null),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-completions",
      provider: "openrouter",
      model: "qwen/qwen-2.5-vl-7b-instruct",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "ocr via models json" }],
    });

    try {
      const result = await describeImageWithModel({
        cfg: {},
        agentDir,
        provider: "openrouter",
        model: "qwen/qwen-2.5-vl-7b-instruct",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      });

      expect(result).toEqual({
        text: "ocr via models json",
        model: "qwen/qwen-2.5-vl-7b-instruct",
      });
      expect(getApiKeyForModelMock).toHaveBeenCalledWith(
        expect.objectContaining({
          model: expect.objectContaining({
            provider: "openrouter",
            id: "qwen/qwen-2.5-vl-7b-instruct",
            baseUrl: "https://openrouter.ai/api/v1",
            input: ["text", "image"],
          }),
        }),
      );
      expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("openrouter", "oauth-test");
      expect(completeMock).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});

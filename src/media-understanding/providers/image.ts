import fs from "node:fs/promises";
import path from "node:path";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import { isMinimaxVlmModel, minimaxUnderstandImage } from "../../agents/minimax-vlm.js";
import {
  getApiKeyForModel,
  requireApiKey,
  resolveApiKeyForProvider,
} from "../../agents/model-auth.js";
import { normalizeModelCompat } from "../../agents/model-compat.js";
import { normalizeModelRef } from "../../agents/model-selection.js";
import { ensureOpenClawModelsJson } from "../../agents/models-config.js";
import { buildConfiguredRequestPayloadOptions } from "../../agents/openrouter-provider-routing.js";
import { coerceImageAssistantText } from "../../agents/tools/image-tool.helpers.js";
import type { ModelApi, ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.js";
import type {
  ImageDescriptionRequest,
  ImageDescriptionResult,
  ImagesDescriptionRequest,
  ImagesDescriptionResult,
} from "../types.js";

let piModelDiscoveryRuntimePromise: Promise<
  typeof import("../../agents/pi-model-discovery-runtime.js")
> | null = null;
const DEFAULT_DYNAMIC_IMAGE_CONTEXT_WINDOW = 200_000;
const DEFAULT_DYNAMIC_IMAGE_MAX_TOKENS = 8_192;
const DEFAULT_DYNAMIC_IMAGE_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

function loadPiModelDiscoveryRuntime() {
  piModelDiscoveryRuntimePromise ??= import("../../agents/pi-model-discovery-runtime.js");
  return piModelDiscoveryRuntimePromise;
}

function resolveImageToolMaxTokens(modelMaxTokens: number | undefined, requestedMaxTokens = 4096) {
  if (
    typeof modelMaxTokens !== "number" ||
    !Number.isFinite(modelMaxTokens) ||
    modelMaxTokens <= 0
  ) {
    return requestedMaxTokens;
  }
  return Math.min(requestedMaxTokens, modelMaxTokens);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveConfiguredProviderConfig(
  cfg: ImageDescriptionRequest["cfg"],
  provider: string,
): ModelProviderConfig | undefined {
  const providers = cfg.models?.providers ?? {};
  const direct = providers[provider];
  if (direct) {
    return direct;
  }
  const normalizedProvider = normalizeModelRef(provider, "auto").provider;
  return Object.entries(providers).find(([key]) => {
    return normalizeModelRef(key, "auto").provider === normalizedProvider;
  })?.[1];
}

async function readProviderConfigFromModelsJson(
  agentDir: string,
  provider: string,
): Promise<ModelProviderConfig | undefined> {
  try {
    const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.providers)) {
      return undefined;
    }
    const providers = parsed.providers;
    const direct = providers[provider];
    if (isRecord(direct)) {
      return direct as ModelProviderConfig;
    }
    const normalizedProvider = normalizeModelRef(provider, "auto").provider;
    const matched = Object.entries(providers).find(([key]) => {
      return normalizeModelRef(key, "auto").provider === normalizedProvider;
    })?.[1];
    return isRecord(matched) ? (matched as ModelProviderConfig) : undefined;
  } catch {
    return undefined;
  }
}

function resolveModelApi(value: unknown): ModelApi {
  switch (value) {
    case "openai-completions":
    case "openai-responses":
    case "openai-codex-responses":
    case "anthropic-messages":
    case "google-generative-ai":
    case "github-copilot":
    case "bedrock-converse-stream":
    case "ollama":
      return value;
    default:
      return "openai-completions";
  }
}

function resolvePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveModelInput(
  value: unknown,
  fallback: Array<"text" | "image">,
): Array<"text" | "image"> {
  const input = Array.isArray(value)
    ? value.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
    : [];
  if (input.length === 0) {
    return fallback;
  }
  return input.includes("image") ? input : [...input, "image"];
}

function resolveModelDefinitionMatch(
  provider: string,
  models: unknown,
  targetModelId: string,
): ModelDefinitionConfig | undefined {
  if (!Array.isArray(models)) {
    return undefined;
  }
  const normalizedTarget = normalizeModelRef(provider, targetModelId).model;
  return models.find((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      return false;
    }
    return normalizeModelRef(provider, entry.id).model === normalizedTarget;
  }) as ModelDefinitionConfig | undefined;
}

function resolveImageTemplateModel(models: unknown): ModelDefinitionConfig | undefined {
  if (!Array.isArray(models)) {
    return undefined;
  }
  const entries = models.filter((entry): entry is ModelDefinitionConfig => {
    return isRecord(entry) && typeof entry.id === "string";
  });
  return (
    entries.find((entry) => Array.isArray(entry.input) && entry.input.includes("image")) ??
    entries[0]
  );
}

async function resolveDynamicImageRuntimeModel(params: {
  cfg: ImageDescriptionRequest["cfg"];
  agentDir: string;
  provider: string;
  model: string;
}): Promise<Model<Api> | null> {
  const resolvedRef = normalizeModelRef(params.provider, params.model);
  const providerConfig =
    resolveConfiguredProviderConfig(params.cfg, resolvedRef.provider) ??
    (await readProviderConfigFromModelsJson(params.agentDir, resolvedRef.provider));
  if (
    !providerConfig ||
    typeof providerConfig.baseUrl !== "string" ||
    !providerConfig.baseUrl.trim()
  ) {
    return null;
  }

  const matchedModel = resolveModelDefinitionMatch(
    resolvedRef.provider,
    providerConfig.models,
    resolvedRef.model,
  );
  const template = matchedModel ?? resolveImageTemplateModel(providerConfig.models);
  if (!template) {
    return null;
  }

  return normalizeModelCompat({
    provider: resolvedRef.provider,
    id: resolvedRef.model,
    name: resolvedRef.model,
    api: resolveModelApi(template.api ?? providerConfig.api),
    reasoning: typeof template.reasoning === "boolean" ? template.reasoning : false,
    input: resolveModelInput(template.input, ["text", "image"]),
    cost: isRecord(template.cost)
      ? {
          input: resolvePositiveNumber(template.cost.input) ?? DEFAULT_DYNAMIC_IMAGE_COST.input,
          output: resolvePositiveNumber(template.cost.output) ?? DEFAULT_DYNAMIC_IMAGE_COST.output,
          cacheRead:
            resolvePositiveNumber(template.cost.cacheRead) ?? DEFAULT_DYNAMIC_IMAGE_COST.cacheRead,
          cacheWrite:
            resolvePositiveNumber(template.cost.cacheWrite) ??
            DEFAULT_DYNAMIC_IMAGE_COST.cacheWrite,
        }
      : { ...DEFAULT_DYNAMIC_IMAGE_COST },
    contextWindow:
      resolvePositiveNumber(template.contextWindow) ?? DEFAULT_DYNAMIC_IMAGE_CONTEXT_WINDOW,
    maxTokens: resolvePositiveNumber(template.maxTokens) ?? DEFAULT_DYNAMIC_IMAGE_MAX_TOKENS,
    baseUrl: providerConfig.baseUrl.trim(),
    headers: providerConfig.headers,
    compat: template.compat,
  } as Model<Api>);
}

async function resolveImageRuntime(params: {
  cfg: ImageDescriptionRequest["cfg"];
  agentDir: string;
  provider: string;
  model: string;
  profile?: string;
  preferredProfile?: string;
}): Promise<{ apiKey: string; model: Model<Api> }> {
  await ensureOpenClawModelsJson(params.cfg, params.agentDir);
  const { discoverAuthStorage, discoverModels } = await loadPiModelDiscoveryRuntime();
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);
  const resolvedRef = normalizeModelRef(params.provider, params.model);
  const model =
    (modelRegistry.find(resolvedRef.provider, resolvedRef.model) as Model<Api> | null) ??
    (await resolveDynamicImageRuntimeModel({
      cfg: params.cfg,
      agentDir: params.agentDir,
      provider: resolvedRef.provider,
      model: resolvedRef.model,
    }));
  if (!model) {
    throw new Error(`Unknown model: ${resolvedRef.provider}/${resolvedRef.model}`);
  }
  if (!model.input?.includes("image")) {
    throw new Error(`Model does not support images: ${params.provider}/${params.model}`);
  }
  const apiKeyInfo = await getApiKeyForModel({
    model,
    cfg: params.cfg,
    agentDir: params.agentDir,
    profileId: params.profile,
    preferredProfile: params.preferredProfile,
  });
  const apiKey = requireApiKey(apiKeyInfo, model.provider);
  authStorage.setRuntimeApiKey(model.provider, apiKey);
  return { apiKey, model };
}

function buildImageContext(
  prompt: string,
  images: Array<{ buffer: Buffer; mime?: string }>,
): Context {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...images.map((image) => ({
            type: "image" as const,
            data: image.buffer.toString("base64"),
            mimeType: image.mime ?? "image/jpeg",
          })),
        ],
        timestamp: Date.now(),
      },
    ],
  };
}

async function describeImagesWithMinimax(params: {
  apiKey: string;
  modelId: string;
  modelBaseUrl?: string;
  prompt: string;
  images: Array<{ buffer: Buffer; mime?: string }>;
}): Promise<ImagesDescriptionResult> {
  const responses: string[] = [];
  for (const [index, image] of params.images.entries()) {
    const prompt =
      params.images.length > 1
        ? `${params.prompt}\n\nDescribe image ${index + 1} of ${params.images.length} independently.`
        : params.prompt;
    const text = await minimaxUnderstandImage({
      apiKey: params.apiKey,
      prompt,
      imageDataUrl: `data:${image.mime ?? "image/jpeg"};base64,${image.buffer.toString("base64")}`,
      modelBaseUrl: params.modelBaseUrl,
    });
    responses.push(params.images.length > 1 ? `Image ${index + 1}:\n${text.trim()}` : text.trim());
  }
  return {
    text: responses.join("\n\n").trim(),
    model: params.modelId,
  };
}

function isUnknownModelError(err: unknown): boolean {
  return err instanceof Error && /^Unknown model:/i.test(err.message);
}

function resolveConfiguredProviderBaseUrl(
  cfg: ImageDescriptionRequest["cfg"],
  provider: string,
): string | undefined {
  const direct = cfg.models?.providers?.[provider];
  if (typeof direct?.baseUrl === "string" && direct.baseUrl.trim()) {
    return direct.baseUrl.trim();
  }
  return undefined;
}

async function resolveMinimaxVlmFallbackRuntime(params: {
  cfg: ImageDescriptionRequest["cfg"];
  agentDir: string;
  provider: string;
  profile?: string;
  preferredProfile?: string;
}): Promise<{ apiKey: string; modelBaseUrl?: string }> {
  const auth = await resolveApiKeyForProvider({
    provider: params.provider,
    cfg: params.cfg,
    profileId: params.profile,
    preferredProfile: params.preferredProfile,
    agentDir: params.agentDir,
  });
  return {
    apiKey: requireApiKey(auth, params.provider),
    modelBaseUrl: resolveConfiguredProviderBaseUrl(params.cfg, params.provider),
  };
}

export async function describeImagesWithModel(
  params: ImagesDescriptionRequest,
): Promise<ImagesDescriptionResult> {
  const prompt = params.prompt ?? "Describe the image.";
  let apiKey: string;
  let model: Model<Api> | undefined;

  try {
    const resolved = await resolveImageRuntime(params);
    apiKey = resolved.apiKey;
    model = resolved.model;
  } catch (err) {
    if (!isMinimaxVlmModel(params.provider, params.model) || !isUnknownModelError(err)) {
      throw err;
    }
    const fallback = await resolveMinimaxVlmFallbackRuntime(params);
    return await describeImagesWithMinimax({
      apiKey: fallback.apiKey,
      modelId: params.model,
      modelBaseUrl: fallback.modelBaseUrl,
      prompt,
      images: params.images,
    });
  }

  if (isMinimaxVlmModel(model.provider, model.id)) {
    return await describeImagesWithMinimax({
      apiKey,
      modelId: model.id,
      modelBaseUrl: model.baseUrl,
      prompt,
      images: params.images,
    });
  }

  const context = buildImageContext(prompt, params.images);
  const message = await complete(model, context, {
    apiKey,
    maxTokens: resolveImageToolMaxTokens(model.maxTokens, params.maxTokens ?? 512),
    ...buildConfiguredRequestPayloadOptions({
      cfg: params.cfg,
      provider: model.provider,
      modelId: model.id,
    }),
  });
  const text = coerceImageAssistantText({
    message,
    provider: model.provider,
    model: model.id,
  });
  return { text, model: model.id };
}

export async function describeImageWithModel(
  params: ImageDescriptionRequest,
): Promise<ImageDescriptionResult> {
  return await describeImagesWithModel({
    images: [
      {
        buffer: params.buffer,
        fileName: params.fileName,
        mime: params.mime,
      },
    ],
    model: params.model,
    provider: params.provider,
    prompt: params.prompt,
    maxTokens: params.maxTokens,
    timeoutMs: params.timeoutMs,
    profile: params.profile,
    preferredProfile: params.preferredProfile,
    agentDir: params.agentDir,
    cfg: params.cfg,
  });
}

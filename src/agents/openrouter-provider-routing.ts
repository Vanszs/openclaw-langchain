import type { Api, Model, ProviderStreamOptions } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/config.js";
import { isRecord } from "../utils.js";
import { resolveModelExtraParams } from "./model-extra-params.js";

type OpenRouterProviderRouting = Record<string, unknown>;

function readBoolean(
  value: Record<string, unknown>,
  snakeCaseKey: string,
  camelCaseKey?: string,
): boolean | undefined {
  const raw = value[snakeCaseKey] ?? (camelCaseKey ? value[camelCaseKey] : undefined);
  return typeof raw === "boolean" ? raw : undefined;
}

function readStringArray(
  value: Record<string, unknown>,
  snakeCaseKey: string,
  camelCaseKey?: string,
): string[] | undefined {
  const raw = value[snakeCaseKey] ?? (camelCaseKey ? value[camelCaseKey] : undefined);
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const normalized = raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function readStringEnum<T extends string>(
  value: Record<string, unknown>,
  snakeCaseKey: string,
  camelCaseKey: string | undefined,
  allowed: readonly T[],
): T | undefined {
  const raw = value[snakeCaseKey] ?? (camelCaseKey ? value[camelCaseKey] : undefined);
  return typeof raw === "string" && allowed.includes(raw as T) ? (raw as T) : undefined;
}

function readNumberOrNumberRecord(
  value: Record<string, unknown>,
  snakeCaseKey: string,
  camelCaseKey: string,
): number | Record<string, number> | undefined {
  const raw = value[snakeCaseKey] ?? value[camelCaseKey];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (!isRecord(raw)) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      out[key] = entry;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readSort(value: Record<string, unknown>): string | Record<string, string> | undefined {
  const raw = value.sort;
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  if (!isRecord(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  if (typeof raw.by === "string" && raw.by.trim()) {
    out.by = raw.by.trim();
  }
  if (typeof raw.partition === "string" && raw.partition.trim()) {
    out.partition = raw.partition.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeOpenRouterProviderRouting(
  value: unknown,
): OpenRouterProviderRouting | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const routing: OpenRouterProviderRouting = {};
  const order = readStringArray(value, "order");
  const only = readStringArray(value, "only");
  const ignore = readStringArray(value, "ignore");
  const quantizations = readStringArray(value, "quantizations");
  const allowFallbacks = readBoolean(value, "allow_fallbacks", "allowFallbacks");
  const requireParameters = readBoolean(value, "require_parameters", "requireParameters");
  const zdr = readBoolean(value, "zdr");
  const enforceDistillableText = readBoolean(
    value,
    "enforce_distillable_text",
    "enforceDistillableText",
  );
  const dataCollection = readStringEnum(value, "data_collection", "dataCollection", [
    "allow",
    "deny",
  ]);
  const sort = readSort(value);
  const preferredMinThroughput = readNumberOrNumberRecord(
    value,
    "preferred_min_throughput",
    "preferredMinThroughput",
  );
  const preferredMaxLatency = readNumberOrNumberRecord(
    value,
    "preferred_max_latency",
    "preferredMaxLatency",
  );
  const maxPrice = (() => {
    const raw = value.max_price ?? value.maxPrice;
    if (!isRecord(raw)) {
      return undefined;
    }
    const out: Record<string, number> = {};
    for (const [key, entry] of Object.entries(raw)) {
      if (typeof entry === "number" && Number.isFinite(entry)) {
        out[key] = entry;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  })();

  if (order) {
    routing.order = order;
  }
  if (only) {
    routing.only = only;
  }
  if (ignore) {
    routing.ignore = ignore;
  }
  if (quantizations) {
    routing.quantizations = quantizations;
  }
  if (allowFallbacks !== undefined) {
    routing.allow_fallbacks = allowFallbacks;
  }
  if (requireParameters !== undefined) {
    routing.require_parameters = requireParameters;
  }
  if (zdr !== undefined) {
    routing.zdr = zdr;
  }
  if (enforceDistillableText !== undefined) {
    routing.enforce_distillable_text = enforceDistillableText;
  }
  if (dataCollection) {
    routing.data_collection = dataCollection;
  }
  if (sort) {
    routing.sort = sort;
  }
  if (preferredMinThroughput !== undefined) {
    routing.preferred_min_throughput = preferredMinThroughput;
  }
  if (preferredMaxLatency !== undefined) {
    routing.preferred_max_latency = preferredMaxLatency;
  }
  if (maxPrice) {
    routing.max_price = maxPrice;
  }

  return Object.keys(routing).length > 0 ? routing : undefined;
}

export function applyOpenRouterProviderRoutingToPayload(
  payload: unknown,
  providerRouting: OpenRouterProviderRouting | undefined,
): unknown {
  if (!providerRouting || !isRecord(payload)) {
    return payload;
  }
  const existing = isRecord(payload.provider) ? payload.provider : {};
  payload.provider = {
    ...existing,
    ...providerRouting,
  };
  return payload;
}

export function buildConfiguredRequestPayloadOptions(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentId?: string;
  onPayload?: ProviderStreamOptions["onPayload"];
}): Pick<ProviderStreamOptions, "onPayload"> {
  if (params.provider !== "openrouter") {
    return params.onPayload ? { onPayload: params.onPayload } : {};
  }

  const providerRouting = normalizeOpenRouterProviderRouting(
    resolveModelExtraParams({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      agentId: params.agentId,
    })?.provider,
  );

  if (!providerRouting) {
    return params.onPayload ? { onPayload: params.onPayload } : {};
  }

  return {
    onPayload: async (payload: unknown, model: Model<Api>) => {
      const routedPayload = applyOpenRouterProviderRoutingToPayload(payload, providerRouting);
      if (!params.onPayload) {
        return routedPayload;
      }
      const transformed = await params.onPayload(routedPayload, model);
      return transformed === undefined ? routedPayload : transformed;
    },
  };
}

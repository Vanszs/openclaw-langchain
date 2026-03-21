import type { OpenClawConfig } from "../config/config.js";
import { getDefaultModelExtraParams } from "./defaults.js";

export function resolveModelExtraParams(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentId?: string;
}): Record<string, unknown> | undefined {
  const modelKey = `${params.provider}/${params.modelId}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
  const builtInParams = getDefaultModelExtraParams(modelKey);
  const globalParams = mergeModelParams(
    builtInParams,
    modelConfig?.params ? { ...modelConfig.params } : undefined,
  );
  const agentParams =
    params.agentId && params.cfg?.agents?.list
      ? params.cfg.agents.list.find((agent) => agent.id === params.agentId)?.params
      : undefined;

  if (!globalParams && !agentParams) {
    return undefined;
  }

  const merged = applyBuiltInProviderRoutingInvariants(
    mergeModelParams(globalParams, agentParams) ?? {},
    builtInParams,
  );
  const resolvedParallelToolCalls = resolveAliasedParamValue(
    [builtInParams, globalParams, agentParams],
    "parallel_tool_calls",
    "parallelToolCalls",
  );
  if (resolvedParallelToolCalls !== undefined) {
    merged.parallel_tool_calls = resolvedParallelToolCalls;
    delete merged.parallelToolCalls;
  }

  return merged;
}

function applyBuiltInProviderRoutingInvariants(
  params: Record<string, unknown>,
  builtInParams: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const builtInProvider = isRecord(builtInParams?.provider) ? builtInParams.provider : undefined;
  const mergedProvider = isRecord(params.provider) ? params.provider : undefined;
  if (!builtInProvider || !mergedProvider) {
    return params;
  }

  const provider = {
    ...mergedProvider,
  };
  const protectedOrder = mergeProtectedStringArray(builtInProvider.order, mergedProvider.order);
  if (protectedOrder) {
    provider.order = protectedOrder;
  }
  const protectedQuantizations = mergeProtectedStringArray(
    builtInProvider.quantizations,
    mergedProvider.quantizations,
  );
  if (protectedQuantizations) {
    provider.quantizations = protectedQuantizations;
  }
  const protectedOnly = Array.isArray(mergedProvider.only)
    ? mergeProtectedStringArray(builtInProvider.order, mergedProvider.only)
    : undefined;
  if (protectedOnly) {
    provider.only = protectedOnly;
  }
  if (builtInProvider.require_parameters === true) {
    provider.require_parameters = true;
  }
  if (builtInProvider.allow_fallbacks === false) {
    provider.allow_fallbacks = false;
  }
  return {
    ...params,
    provider,
  };
}

function mergeModelParams(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base && !override) {
    return undefined;
  }
  const merged: Record<string, unknown> = {
    ...base,
    ...override,
  };
  const baseProvider = isRecord(base?.provider) ? base.provider : undefined;
  const overrideProvider = isRecord(override?.provider) ? override.provider : undefined;
  if (baseProvider || overrideProvider) {
    merged.provider = {
      ...baseProvider,
      ...overrideProvider,
    };
  }
  return merged;
}

function resolveAliasedParamValue(
  sources: Array<Record<string, unknown> | undefined>,
  snakeCaseKey: string,
  camelCaseKey: string,
): unknown {
  let resolved: unknown = undefined;
  let seen = false;
  for (const source of sources) {
    if (!source) {
      continue;
    }
    const hasSnakeCaseKey = Object.hasOwn(source, snakeCaseKey);
    const hasCamelCaseKey = Object.hasOwn(source, camelCaseKey);
    if (!hasSnakeCaseKey && !hasCamelCaseKey) {
      continue;
    }
    resolved = hasSnakeCaseKey ? source[snakeCaseKey] : source[camelCaseKey];
    seen = true;
  }
  return seen ? resolved : undefined;
}

function mergeProtectedStringArray(
  requiredRaw: unknown,
  overrideRaw: unknown,
): string[] | undefined {
  const required = Array.isArray(requiredRaw)
    ? requiredRaw.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
  const override = Array.isArray(overrideRaw)
    ? overrideRaw.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
  if (required.length === 0 && override.length === 0) {
    return undefined;
  }
  return [...new Set([...required, ...override])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

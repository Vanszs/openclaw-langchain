import { randomUUID } from "node:crypto";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import {
  resolveAllowedModelRef,
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "../agents/model-selection.js";
import { normalizeGroupActivation } from "../auto-reply/group-activation.js";
import {
  formatThinkingLevels,
  formatXHighModelHint,
  normalizeElevatedLevel,
  normalizeFastMode,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  normalizeUsageDisplay,
  supportsXHighThinking,
} from "../auto-reply/thinking.js";
import { normalizeChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { applyVerboseOverride, parseVerboseOverride } from "../sessions/level-overrides.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { normalizeSendPolicy } from "../sessions/send-policy.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import { normalizeAccountId } from "../utils/account-id.js";
import { normalizeSessionDeliveryFields } from "../utils/delivery-context.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsPatchParams,
} from "./protocol/index.js";

function invalid(message: string): { ok: false; error: ErrorShape } {
  return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, message) };
}

function normalizeExecHost(raw: string): "sandbox" | "gateway" | "node" | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "sandbox" || normalized === "gateway" || normalized === "node") {
    return normalized;
  }
  return undefined;
}

function normalizeExecSecurity(raw: string): "deny" | "allowlist" | "full" | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return undefined;
}

function normalizeExecAsk(raw: string): "off" | "on-miss" | "always" | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized;
  }
  return undefined;
}

function supportsSpawnLineage(storeKey: string): boolean {
  return isSubagentSessionKey(storeKey) || isAcpSessionKey(storeKey);
}

function normalizeSubagentRole(raw: string): "orchestrator" | "leaf" | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "orchestrator" || normalized === "leaf") {
    return normalized;
  }
  return undefined;
}

function normalizeSubagentControlScope(raw: string): "children" | "none" | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "children" || normalized === "none") {
    return normalized;
  }
  return undefined;
}

function normalizeThreadId(raw: string | number | null | undefined): string | number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeSessionOriginPatch(
  raw: NonNullable<SessionsPatchParams["origin"]>,
): SessionEntry["origin"] | undefined {
  const label = typeof raw.label === "string" ? raw.label.trim() : undefined;
  const provider =
    typeof raw.provider === "string"
      ? (normalizeMessageChannel(raw.provider) ?? raw.provider.trim())
      : undefined;
  const surface =
    typeof raw.surface === "string"
      ? (normalizeMessageChannel(raw.surface) ?? raw.surface.trim())
      : undefined;
  const chatType = typeof raw.chatType === "string" ? normalizeChatType(raw.chatType) : undefined;
  const from = typeof raw.from === "string" ? raw.from.trim() : undefined;
  const to = typeof raw.to === "string" ? raw.to.trim() : undefined;
  const accountId = normalizeAccountId(raw.accountId);
  const threadId = normalizeThreadId(raw.threadId);
  if (!label && !provider && !surface && !chatType && !from && !to && !accountId && !threadId) {
    return undefined;
  }
  const origin: NonNullable<SessionEntry["origin"]> = {};
  if (label) {
    origin.label = label;
  }
  if (provider) {
    origin.provider = provider;
  }
  if (surface) {
    origin.surface = surface;
  }
  if (chatType) {
    origin.chatType = chatType;
  }
  if (from) {
    origin.from = from;
  }
  if (to) {
    origin.to = to;
  }
  if (accountId) {
    origin.accountId = accountId;
  }
  if (threadId != null) {
    origin.threadId = threadId;
  }
  return origin;
}

export async function applySessionsPatchToStore(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  storeKey: string;
  patch: SessionsPatchParams;
  loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
}): Promise<{ ok: true; entry: SessionEntry } | { ok: false; error: ErrorShape }> {
  const { cfg, store, storeKey, patch } = params;
  const now = Date.now();
  const parsedAgent = parseAgentSessionKey(storeKey);
  const sessionAgentId = normalizeAgentId(parsedAgent?.agentId ?? resolveDefaultAgentId(cfg));
  const resolvedDefault = resolveDefaultModelForAgent({ cfg, agentId: sessionAgentId });
  const subagentModelHint = isSubagentSessionKey(storeKey)
    ? resolveSubagentConfiguredModelSelection({ cfg, agentId: sessionAgentId })
    : undefined;

  const existing = store[storeKey];
  const next: SessionEntry = existing
    ? {
        ...existing,
        updatedAt: Math.max(existing.updatedAt ?? 0, now),
      }
    : { sessionId: randomUUID(), updatedAt: now };

  if ("spawnedBy" in patch) {
    const raw = patch.spawnedBy;
    if (raw === null) {
      if (existing?.spawnedBy) {
        return invalid("spawnedBy cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      const trimmed = String(raw).trim();
      if (!trimmed) {
        return invalid("invalid spawnedBy: empty");
      }
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("spawnedBy is only supported for subagent:* or acp:* sessions");
      }
      if (existing?.spawnedBy && existing.spawnedBy !== trimmed) {
        return invalid("spawnedBy cannot be changed once set");
      }
      next.spawnedBy = trimmed;
    }
  }

  if ("spawnedWorkspaceDir" in patch) {
    const raw = patch.spawnedWorkspaceDir;
    if (raw === null) {
      if (existing?.spawnedWorkspaceDir) {
        return invalid("spawnedWorkspaceDir cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("spawnedWorkspaceDir is only supported for subagent:* or acp:* sessions");
      }
      const trimmed = String(raw).trim();
      if (!trimmed) {
        return invalid("invalid spawnedWorkspaceDir: empty");
      }
      if (existing?.spawnedWorkspaceDir && existing.spawnedWorkspaceDir !== trimmed) {
        return invalid("spawnedWorkspaceDir cannot be changed once set");
      }
      next.spawnedWorkspaceDir = trimmed;
    }
  }

  if ("spawnDepth" in patch) {
    const raw = patch.spawnDepth;
    if (raw === null) {
      if (typeof existing?.spawnDepth === "number") {
        return invalid("spawnDepth cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("spawnDepth is only supported for subagent:* or acp:* sessions");
      }
      const numeric = Number(raw);
      if (!Number.isInteger(numeric) || numeric < 0) {
        return invalid("invalid spawnDepth (use an integer >= 0)");
      }
      const normalized = numeric;
      if (typeof existing?.spawnDepth === "number" && existing.spawnDepth !== normalized) {
        return invalid("spawnDepth cannot be changed once set");
      }
      next.spawnDepth = normalized;
    }
  }

  if ("subagentRole" in patch) {
    const raw = patch.subagentRole;
    if (raw === null) {
      if (existing?.subagentRole) {
        return invalid("subagentRole cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("subagentRole is only supported for subagent:* or acp:* sessions");
      }
      const normalized = normalizeSubagentRole(String(raw));
      if (!normalized) {
        return invalid('invalid subagentRole (use "orchestrator" or "leaf")');
      }
      if (existing?.subagentRole && existing.subagentRole !== normalized) {
        return invalid("subagentRole cannot be changed once set");
      }
      next.subagentRole = normalized;
    }
  }

  if ("subagentControlScope" in patch) {
    const raw = patch.subagentControlScope;
    if (raw === null) {
      if (existing?.subagentControlScope) {
        return invalid("subagentControlScope cannot be cleared once set");
      }
    } else if (raw !== undefined) {
      if (!supportsSpawnLineage(storeKey)) {
        return invalid("subagentControlScope is only supported for subagent:* or acp:* sessions");
      }
      const normalized = normalizeSubagentControlScope(String(raw));
      if (!normalized) {
        return invalid('invalid subagentControlScope (use "children" or "none")');
      }
      if (existing?.subagentControlScope && existing.subagentControlScope !== normalized) {
        return invalid("subagentControlScope cannot be changed once set");
      }
      next.subagentControlScope = normalized;
    }
  }

  if ("chatType" in patch && patch.chatType !== undefined) {
    const normalized = normalizeChatType(String(patch.chatType));
    if (!normalized) {
      return invalid('invalid chatType (use "direct", "group", or "channel")');
    }
    next.chatType = normalized;
  }

  if ("origin" in patch && patch.origin !== undefined) {
    const normalized = normalizeSessionOriginPatch(patch.origin);
    if (!normalized) {
      return invalid("invalid origin: at least one non-empty field is required");
    }
    next.origin = {
      ...next.origin,
      ...normalized,
    };
  }

  if (
    "deliveryContext" in patch ||
    "lastChannel" in patch ||
    "lastTo" in patch ||
    "lastAccountId" in patch ||
    "lastThreadId" in patch
  ) {
    const currentDelivery = normalizeSessionDeliveryFields({
      channel: next.channel,
      lastChannel: next.lastChannel,
      lastTo: next.lastTo,
      lastAccountId: next.lastAccountId,
      lastThreadId: next.lastThreadId ?? next.deliveryContext?.threadId ?? next.origin?.threadId,
      deliveryContext: next.deliveryContext,
    });
    const requestedDelivery = normalizeSessionDeliveryFields({
      channel:
        patch.deliveryContext?.channel ??
        (typeof patch.lastChannel === "string" ? patch.lastChannel : undefined),
      lastChannel:
        typeof patch.lastChannel === "string" ? patch.lastChannel : patch.deliveryContext?.channel,
      lastTo: typeof patch.lastTo === "string" ? patch.lastTo : patch.deliveryContext?.to,
      lastAccountId:
        typeof patch.lastAccountId === "string"
          ? patch.lastAccountId
          : patch.deliveryContext?.accountId,
      lastThreadId: patch.lastThreadId ?? patch.deliveryContext?.threadId,
      deliveryContext: patch.deliveryContext,
    });
    const mergedDelivery = normalizeSessionDeliveryFields({
      channel: next.channel,
      lastChannel: requestedDelivery.lastChannel ?? currentDelivery.lastChannel,
      lastTo: requestedDelivery.lastTo ?? currentDelivery.lastTo,
      lastAccountId: requestedDelivery.lastAccountId ?? currentDelivery.lastAccountId,
      lastThreadId: requestedDelivery.lastThreadId ?? currentDelivery.lastThreadId,
      deliveryContext: requestedDelivery.deliveryContext ?? currentDelivery.deliveryContext,
    });
    next.deliveryContext = mergedDelivery.deliveryContext;
    next.lastChannel = mergedDelivery.lastChannel;
    next.lastTo = mergedDelivery.lastTo;
    next.lastAccountId = mergedDelivery.lastAccountId;
    next.lastThreadId = mergedDelivery.lastThreadId;
  }

  if ("label" in patch) {
    const raw = patch.label;
    if (raw === null) {
      delete next.label;
    } else if (raw !== undefined) {
      const parsed = parseSessionLabel(raw);
      if (!parsed.ok) {
        return invalid(parsed.error);
      }
      for (const [key, entry] of Object.entries(store)) {
        if (key === storeKey) {
          continue;
        }
        if (entry?.label === parsed.label) {
          return invalid(`label already in use: ${parsed.label}`);
        }
      }
      next.label = parsed.label;
    }
  }

  if ("thinkingLevel" in patch) {
    const raw = patch.thinkingLevel;
    if (raw === null) {
      // Clear the override and fall back to model default
      delete next.thinkingLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeThinkLevel(String(raw));
      if (!normalized) {
        const hintProvider = existing?.providerOverride?.trim() || resolvedDefault.provider;
        const hintModel = existing?.modelOverride?.trim() || resolvedDefault.model;
        return invalid(
          `invalid thinkingLevel (use ${formatThinkingLevels(hintProvider, hintModel, "|")})`,
        );
      }
      next.thinkingLevel = normalized;
    }
  }

  if ("fastMode" in patch) {
    const raw = patch.fastMode;
    if (raw === null) {
      delete next.fastMode;
    } else if (raw !== undefined) {
      const normalized = normalizeFastMode(raw);
      if (normalized === undefined) {
        return invalid("invalid fastMode (use true or false)");
      }
      next.fastMode = normalized;
    }
  }

  if ("verboseLevel" in patch) {
    const raw = patch.verboseLevel;
    const parsed = parseVerboseOverride(raw);
    if (!parsed.ok) {
      return invalid(parsed.error);
    }
    applyVerboseOverride(next, parsed.value);
  }

  if ("reasoningLevel" in patch) {
    const raw = patch.reasoningLevel;
    if (raw === null) {
      delete next.reasoningLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeReasoningLevel(String(raw));
      if (!normalized) {
        return invalid('invalid reasoningLevel (use "on"|"off"|"stream")');
      }
      // Persist "off" explicitly so that resolveDefaultReasoningLevel()
      // does not re-enable reasoning for capable models (#24406).
      next.reasoningLevel = normalized;
    }
  }

  if ("responseUsage" in patch) {
    const raw = patch.responseUsage;
    if (raw === null) {
      delete next.responseUsage;
    } else if (raw !== undefined) {
      const normalized = normalizeUsageDisplay(String(raw));
      if (!normalized) {
        return invalid('invalid responseUsage (use "off"|"tokens"|"full")');
      }
      if (normalized === "off") {
        delete next.responseUsage;
      } else {
        next.responseUsage = normalized;
      }
    }
  }

  if ("elevatedLevel" in patch) {
    const raw = patch.elevatedLevel;
    if (raw === null) {
      delete next.elevatedLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeElevatedLevel(String(raw));
      if (!normalized) {
        return invalid('invalid elevatedLevel (use "on"|"off"|"ask"|"full")');
      }
      // Persist "off" explicitly so patches can override defaults.
      next.elevatedLevel = normalized;
    }
  }

  if ("execHost" in patch) {
    const raw = patch.execHost;
    if (raw === null) {
      delete next.execHost;
    } else if (raw !== undefined) {
      const normalized = normalizeExecHost(String(raw));
      if (!normalized) {
        return invalid('invalid execHost (use "sandbox"|"gateway"|"node")');
      }
      next.execHost = normalized;
    }
  }

  if ("execSecurity" in patch) {
    const raw = patch.execSecurity;
    if (raw === null) {
      delete next.execSecurity;
    } else if (raw !== undefined) {
      const normalized = normalizeExecSecurity(String(raw));
      if (!normalized) {
        return invalid('invalid execSecurity (use "deny"|"allowlist"|"full")');
      }
      next.execSecurity = normalized;
    }
  }

  if ("execAsk" in patch) {
    const raw = patch.execAsk;
    if (raw === null) {
      delete next.execAsk;
    } else if (raw !== undefined) {
      const normalized = normalizeExecAsk(String(raw));
      if (!normalized) {
        return invalid('invalid execAsk (use "off"|"on-miss"|"always")');
      }
      next.execAsk = normalized;
    }
  }

  if ("execNode" in patch) {
    const raw = patch.execNode;
    if (raw === null) {
      delete next.execNode;
    } else if (raw !== undefined) {
      const trimmed = String(raw).trim();
      if (!trimmed) {
        return invalid("invalid execNode: empty");
      }
      next.execNode = trimmed;
    }
  }

  if ("model" in patch) {
    const raw = patch.model;
    if (raw === null) {
      applyModelOverrideToSessionEntry({
        entry: next,
        selection: {
          provider: resolvedDefault.provider,
          model: resolvedDefault.model,
          isDefault: true,
        },
      });
    } else if (raw !== undefined) {
      const trimmed = String(raw).trim();
      if (!trimmed) {
        return invalid("invalid model: empty");
      }
      if (!params.loadGatewayModelCatalog) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.UNAVAILABLE, "model catalog unavailable"),
        };
      }
      const catalog = await params.loadGatewayModelCatalog();
      const resolved = resolveAllowedModelRef({
        cfg,
        catalog,
        raw: trimmed,
        defaultProvider: resolvedDefault.provider,
        defaultModel: subagentModelHint ?? resolvedDefault.model,
      });
      if ("error" in resolved) {
        return invalid(resolved.error);
      }
      const isDefault =
        resolved.ref.provider === resolvedDefault.provider &&
        resolved.ref.model === resolvedDefault.model;
      applyModelOverrideToSessionEntry({
        entry: next,
        selection: {
          provider: resolved.ref.provider,
          model: resolved.ref.model,
          isDefault,
        },
      });
    }
  }

  if (next.thinkingLevel === "xhigh") {
    const effectiveProvider = next.providerOverride ?? resolvedDefault.provider;
    const effectiveModel = next.modelOverride ?? resolvedDefault.model;
    if (!supportsXHighThinking(effectiveProvider, effectiveModel)) {
      if ("thinkingLevel" in patch) {
        return invalid(`thinkingLevel "xhigh" is only supported for ${formatXHighModelHint()}`);
      }
      next.thinkingLevel = "high";
    }
  }

  if ("sendPolicy" in patch) {
    const raw = patch.sendPolicy;
    if (raw === null) {
      delete next.sendPolicy;
    } else if (raw !== undefined) {
      const normalized = normalizeSendPolicy(String(raw));
      if (!normalized) {
        return invalid('invalid sendPolicy (use "allow"|"deny")');
      }
      next.sendPolicy = normalized;
    }
  }

  if ("groupActivation" in patch) {
    const raw = patch.groupActivation;
    if (raw === null) {
      delete next.groupActivation;
    } else if (raw !== undefined) {
      const normalized = normalizeGroupActivation(String(raw));
      if (!normalized) {
        return invalid('invalid groupActivation (use "mention"|"always")');
      }
      next.groupActivation = normalized;
    }
  }

  store[storeKey] = next;
  return { ok: true, entry: next };
}

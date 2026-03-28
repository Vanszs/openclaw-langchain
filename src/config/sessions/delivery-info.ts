import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  deliveryContextFromSession,
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import type { OpenClawConfig } from "../config.js";
import { loadConfig } from "../io.js";
import { resolveStorePath } from "./paths.js";
import { loadSessionStore } from "./store.js";

/**
 * Extract deliveryContext and threadId from a sessionKey.
 * Supports both :thread: (most channels) and :topic: (Telegram).
 */
export function parseSessionThreadInfo(sessionKey: string | undefined): {
  baseSessionKey: string | undefined;
  threadId: string | undefined;
} {
  if (!sessionKey) {
    return { baseSessionKey: undefined, threadId: undefined };
  }
  const topicIndex = sessionKey.lastIndexOf(":topic:");
  const threadIndex = sessionKey.lastIndexOf(":thread:");
  const markerIndex = Math.max(topicIndex, threadIndex);
  const marker = topicIndex > threadIndex ? ":topic:" : ":thread:";

  const baseSessionKey = markerIndex === -1 ? sessionKey : sessionKey.slice(0, markerIndex);
  const threadIdRaw =
    markerIndex === -1 ? undefined : sessionKey.slice(markerIndex + marker.length);
  const threadId = threadIdRaw?.trim() || undefined;
  return { baseSessionKey, threadId };
}

export function extractDeliveryInfo(sessionKey: string | undefined): {
  deliveryContext: { channel?: string; to?: string; accountId?: string } | undefined;
  threadId: string | undefined;
} {
  const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
  if (!sessionKey || !baseSessionKey) {
    return { deliveryContext: undefined, threadId };
  }

  let deliveryContext: { channel?: string; to?: string; accountId?: string } | undefined;
  try {
    const cfg = loadConfig();
    const storePath = resolveStorePath(cfg.session?.store);
    const store = loadSessionStore(storePath);
    let entry = store[sessionKey];
    if (!entry?.deliveryContext && baseSessionKey !== sessionKey) {
      entry = store[baseSessionKey];
    }
    if (entry?.deliveryContext) {
      deliveryContext = {
        channel: entry.deliveryContext.channel,
        to: entry.deliveryContext.to,
        accountId: entry.deliveryContext.accountId,
      };
    }
  } catch {
    // ignore: best-effort
  }
  if (!deliveryContext?.to) {
    deliveryContext = mergeDeliveryContexts(
      deliveryContext,
      deriveDeliveryContextFromExplicitSessionKey(baseSessionKey),
    );
  }
  return { deliveryContext, threadId };
}

export function findMirroredTranscriptSessionKey(params: {
  cfg?: Pick<OpenClawConfig, "session">;
  agentId?: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
}): string | undefined {
  const targetContext = normalizeDeliveryContext({
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    threadId: params.threadId,
  });
  const targetKey = deliveryContextKey(targetContext);
  if (!targetContext?.channel || !targetContext.to) {
    return undefined;
  }

  const storePath = resolveStorePath(
    params.cfg?.session?.store,
    params.agentId ? { agentId: params.agentId } : undefined,
  );
  const store = loadSessionStore(storePath);
  const matches: string[] = [];
  for (const [sessionKey, entry] of Object.entries(store)) {
    const deliveryContext =
      deliveryContextFromSession(entry) ??
      deriveDeliveryContextFromExplicitSessionKey(
        parseSessionThreadInfo(sessionKey).baseSessionKey,
      );
    if (!matchesMirroredTranscriptTarget(targetContext, deliveryContext, targetKey)) {
      continue;
    }
    matches.push(sessionKey);
  }
  if (matches.length === 0) {
    return undefined;
  }
  return matches.toSorted(compareSessionKeySpecificity)[0];
}

function mergeDeliveryContexts(
  primary: { channel?: string; to?: string; accountId?: string } | undefined,
  fallback: { channel?: string; to?: string; accountId?: string } | undefined,
): { channel?: string; to?: string; accountId?: string } | undefined {
  if (!primary && !fallback) {
    return undefined;
  }
  return {
    channel: primary?.channel ?? fallback?.channel,
    to: primary?.to ?? fallback?.to,
    accountId: primary?.accountId ?? fallback?.accountId,
  };
}

function deriveDeliveryContextFromExplicitSessionKey(sessionKey: string | undefined):
  | {
      channel?: string;
      to?: string;
      accountId?: string;
    }
  | undefined {
  const rest = parseAgentSessionKey(sessionKey)?.rest ?? sessionKey;
  const scoped = (rest ?? "").trim().toLowerCase();
  if (!scoped) {
    return undefined;
  }
  const parts = scoped.split(":").filter(Boolean);
  const channel = normalizeMessageChannel(parts[0]);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || !isDeliverableMessageChannel(channel)) {
    return undefined;
  }

  const peerShape = parts[1];
  if (
    peerShape === "direct" ||
    peerShape === "dm" ||
    peerShape === "group" ||
    peerShape === "channel"
  ) {
    const to = parts.slice(2).join(":");
    return to ? { channel, to } : { channel };
  }

  const accountScopedPeerShape = parts[2];
  if (
    accountScopedPeerShape === "direct" ||
    accountScopedPeerShape === "dm" ||
    accountScopedPeerShape === "group" ||
    accountScopedPeerShape === "channel"
  ) {
    const accountId = parts[1];
    const to = parts.slice(3).join(":");
    return {
      channel,
      ...(to ? { to } : {}),
      ...(accountId ? { accountId } : {}),
    };
  }

  const legacyTo = parts.slice(1).join(":");
  return legacyTo ? { channel, to: legacyTo } : { channel };
}

function compareSessionKeySpecificity(left: string, right: string): number {
  const leftPenalty = sessionKeyMirrorPenalty(left);
  const rightPenalty = sessionKeyMirrorPenalty(right);
  if (leftPenalty !== rightPenalty) {
    return leftPenalty - rightPenalty;
  }
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  return left.localeCompare(right);
}

function sessionKeyMirrorPenalty(sessionKey: string): number {
  let penalty = 0;
  if (sessionKey.includes(":run:")) {
    penalty += 100;
  }
  if (sessionKey.includes(":cron:")) {
    penalty += 50;
  }
  if (sessionKey.includes(":subagent:")) {
    penalty += 25;
  }
  return penalty;
}

function matchesMirroredTranscriptTarget(
  target: ReturnType<typeof normalizeDeliveryContext>,
  candidate: ReturnType<typeof normalizeDeliveryContext>,
  targetKey: string | undefined,
): boolean {
  const candidateKey = deliveryContextKey(candidate);
  if (targetKey && candidateKey === targetKey) {
    return true;
  }
  if (!target?.channel || !target.to || !candidate?.channel || !candidate.to) {
    return false;
  }
  if (candidate.channel !== target.channel) {
    return false;
  }
  if (
    normalizeMirroredRecipientIdentity(target.channel, candidate.to) !==
    normalizeMirroredRecipientIdentity(target.channel, target.to)
  ) {
    return false;
  }
  if ((candidate.accountId ?? "") !== (target.accountId ?? "")) {
    return false;
  }
  const candidateThread = candidate.threadId != null ? String(candidate.threadId) : "";
  const targetThread = target.threadId != null ? String(target.threadId) : "";
  return candidateThread === targetThread;
}

function normalizeMirroredRecipientIdentity(channel: string, value: string): string {
  let normalized = value.trim().toLowerCase();
  if (!normalized) {
    return normalized;
  }
  const channelPrefix = `${channel.toLowerCase()}:`;
  if (normalized.startsWith(channelPrefix)) {
    normalized = normalized.slice(channelPrefix.length);
  }
  if (normalized.startsWith("user:")) {
    normalized = normalized.slice("user:".length);
  }
  return normalized;
}

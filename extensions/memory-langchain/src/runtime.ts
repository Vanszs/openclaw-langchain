import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  loadSessionStore,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/config-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/core";
import { makeStableId, resolveLangchainPluginConfig } from "./config.js";
import { LangchainMemoryManager } from "./manager.js";

type InboundQueueEvent = {
  kind: "inbound";
  agentId: string;
  source: "chat" | "email";
  sessionKey?: string;
  channelId: string;
  from?: string;
  to?: string;
  provider?: string;
  surface?: string;
  body?: string;
  bodyForAgent?: string;
  subject?: string;
  attachmentText?: string;
  transcript?: string;
  accountId?: string;
  conversationId?: string;
  messageId?: string;
  threadId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  mediaPath?: string;
  mediaType?: string;
  originatingChannel?: string;
  originatingTo?: string;
  guildId?: string;
  channelName?: string;
  groupId?: string;
  timestamp?: number;
  isGroup?: boolean;
  accessTag?: string;
  content: string;
};

type SessionQueueEvent = {
  kind: "session";
  agentId: string;
  sessionKey?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  threadId?: string;
  senderId?: string;
  provider?: string;
  surface?: string;
  originatingChannel?: string;
  originatingTo?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  subject?: string;
  chatType?: string;
  accessTag?: string;
  role?: string;
  content: string;
};

type QueueEvent = InboundQueueEvent | SessionQueueEvent;
const MAX_QUEUE_RETRIES = 3;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readQueueRetryAttempt(fileName: string): number {
  const match = fileName.match(/\.retry-(\d+)\.json$/i);
  if (!match) {
    return 0;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function buildRetryPath(entry: string, nextAttempt: number): string {
  const directory = path.dirname(entry);
  const fileName = path.basename(entry);
  const base = fileName.replace(/\.retry-\d+\.json$/i, ".json");
  const stem = base.replace(/\.json$/i, "");
  return path.join(directory, `${stem}.retry-${nextAttempt}.json`);
}

function parseAgentSessionKey(
  sessionKey: string | undefined,
): { agentId: string; rest: string } | null {
  const raw = normalizeText(sessionKey).toLowerCase();
  if (!raw.startsWith("agent:")) {
    return null;
  }
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent") {
    return null;
  }
  const agentId = parts[1] ?? "";
  const rest = parts.slice(2).join(":");
  return agentId && rest ? { agentId, rest } : null;
}

function deriveAgentId(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): string {
  const explicit = normalizeText(params.agentId);
  if (explicit) {
    return explicit;
  }
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  return resolveDefaultAgentId(params.cfg);
}

function normalizeThreadId(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    const normalized = String(value).trim();
    return normalized || undefined;
  }
  return undefined;
}

function deriveAccessTag(params: {
  source: "chat" | "email" | "sessions";
  sessionKey?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  isGroup?: boolean;
}): string {
  const sessionKey = normalizeText(params.sessionKey).toLowerCase();
  if (sessionKey) {
    return `session:${sessionKey}`;
  }
  const channelId = normalizeText(params.channelId).toLowerCase();
  const accountId = normalizeText(params.accountId).toLowerCase() || "default";
  const conversationId = normalizeText(params.conversationId).toLowerCase();
  if (channelId && conversationId) {
    return `${channelId}:${accountId}:${params.isGroup ? "group" : "direct"}:${conversationId}`;
  }
  if (channelId) {
    return `${channelId}:${accountId}:${params.isGroup ? "group" : "direct"}`;
  }
  return params.source;
}

function inferSessionRouteFromSessionKey(
  sessionKey: string | undefined,
): Partial<SessionQueueEvent> {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return {};
  }
  const tokens = parsed.rest.split(":").filter(Boolean);
  if (tokens.length === 0 || tokens[0] === "main") {
    return {};
  }
  const routeMarkers = new Set(["direct", "group", "channel"]);
  const threadMarkers = new Set(["thread", "topic"]);
  const channelId = tokens[0];
  let accountId: string | undefined;
  let routeStartIndex = 1;
  if (
    tokens.length >= 3 &&
    !routeMarkers.has(tokens[1] ?? "") &&
    !threadMarkers.has(tokens[1] ?? "")
  ) {
    accountId = tokens[1];
    routeStartIndex = 2;
  }
  const routeTokens = tokens.slice(routeStartIndex);
  const threadMarkerIndex = routeTokens.findIndex((token) => threadMarkers.has(token));
  const headTokens = threadMarkerIndex >= 0 ? routeTokens.slice(0, threadMarkerIndex) : routeTokens;
  const threadId =
    threadMarkerIndex >= 0 ? normalizeThreadId(routeTokens[threadMarkerIndex + 1]) : undefined;
  const chatType = headTokens.find((token) => routeMarkers.has(token));
  const conversationId = headTokens.length > 0 ? headTokens.join(":") : undefined;
  return {
    channelId,
    accountId,
    conversationId,
    threadId,
    chatType,
    groupId: chatType === "group" ? conversationId : undefined,
  };
}

function hasExplicitWorkspace(cfg: OpenClawConfig, agentId: string): boolean {
  const normalizedAgentId = agentId.trim().toLowerCase();
  const explicit = (cfg.agents?.list ?? []).find(
    (agent) => agent.id?.trim().toLowerCase() === normalizedAgentId,
  );
  if (typeof explicit?.workspace === "string" && explicit.workspace.trim()) {
    return true;
  }
  return (
    normalizedAgentId === resolveDefaultAgentId(cfg) &&
    typeof cfg.agents?.defaults?.workspace === "string" &&
    cfg.agents.defaults.workspace.trim().length > 0
  );
}

function resolveWorkspaceForAgent(
  cfg: OpenClawConfig,
  agentId: string,
  fallbackWorkspaceDir: string,
): string {
  if (!hasExplicitWorkspace(cfg, agentId)) {
    const fallback = normalizeText(fallbackWorkspaceDir);
    if (fallback) {
      return fallback;
    }
  }
  return resolveAgentWorkspaceDir(cfg, agentId);
}

function classifyInboundSource(channelId: string): "chat" | "email" {
  const normalized = channelId.trim().toLowerCase();
  return normalized.includes("mail") || normalized.includes("gmail") || normalized === "email"
    ? "email"
    : "chat";
}

function resolveSessionMetadata(
  cfg: OpenClawConfig,
  agentId: string,
  sessionKey: string | undefined,
): Partial<SessionQueueEvent> {
  const inferred = inferSessionRouteFromSessionKey(sessionKey);
  const normalizedSessionKey = normalizeText(sessionKey) || undefined;
  if (!normalizedSessionKey) {
    return inferred;
  }
  try {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const { existing } = resolveSessionStoreEntry({ store, sessionKey: normalizedSessionKey });
    if (!existing) {
      return inferred;
    }
    const origin = existing.origin;
    const delivery = existing.deliveryContext;
    return {
      ...inferred,
      channelId:
        normalizeText(delivery?.channel ?? existing.lastChannel ?? existing.channel) ||
        normalizeText(origin?.provider ?? origin?.surface) ||
        inferred.channelId,
      accountId:
        normalizeText(delivery?.accountId ?? existing.lastAccountId ?? origin?.accountId) ||
        inferred.accountId,
      conversationId:
        normalizeText(delivery?.to ?? existing.lastTo ?? origin?.to) || inferred.conversationId,
      threadId:
        normalizeThreadId(delivery?.threadId ?? existing.lastThreadId ?? origin?.threadId) ||
        inferred.threadId,
      senderId: normalizeText(origin?.from) || undefined,
      provider: normalizeText(origin?.provider) || undefined,
      surface: normalizeText(origin?.surface) || undefined,
      originatingChannel:
        normalizeText(delivery?.channel ?? existing.lastChannel ?? existing.channel) || undefined,
      originatingTo: normalizeText(delivery?.to ?? existing.lastTo) || undefined,
      groupId: normalizeText(existing.groupId) || inferred.groupId,
      groupChannel: normalizeText(existing.groupChannel) || undefined,
      groupSpace: normalizeText(existing.space) || undefined,
      subject: normalizeText(existing.subject) || undefined,
      chatType: normalizeText(existing.chatType) || inferred.chatType,
    };
  } catch (error) {
    return {
      ...inferred,
      ...(normalizedSessionKey
        ? { accessTag: `session-store-unavailable:${normalizedSessionKey.toLowerCase()}` }
        : {}),
    };
  }
}

async function appendJson(pathname: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function appendLogEvent(pathname: string, payload: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.appendFile(pathname, `${JSON.stringify(payload)}\n`, "utf-8");
}

function buildInboundDocBody(event: InboundQueueEvent): string {
  const seenBlocks = new Set<string>();
  const contentText = normalizeText(event.content);
  if (contentText) {
    seenBlocks.add(contentText.toLowerCase());
  }
  const pushBlock = (label: string, value: string | undefined) => {
    const normalized = normalizeText(value);
    if (!normalized) {
      return null;
    }
    const dedupeKey = normalized.toLowerCase();
    if (seenBlocks.has(dedupeKey)) {
      return null;
    }
    seenBlocks.add(dedupeKey);
    return `\n## ${label}\n${normalized}`;
  };
  const lines = [
    `# ${event.source === "email" ? "Email" : "Chat"} message`,
    event.sessionKey ? `Session: ${event.sessionKey}` : null,
    event.provider ? `Provider: ${event.provider}` : null,
    event.surface ? `Surface: ${event.surface}` : null,
    `Channel: ${event.channelId}`,
    event.subject ? `Subject: ${event.subject}` : null,
    event.from ? `From: ${event.from}` : null,
    event.to ? `To: ${event.to}` : null,
    event.conversationId ? `Conversation: ${event.conversationId}` : null,
    event.threadId ? `Thread: ${event.threadId}` : null,
    event.senderName
      ? `Sender: ${event.senderName}`
      : event.senderId
        ? `Sender: ${event.senderId}`
        : null,
    event.senderE164 ? `Sender E164: ${event.senderE164}` : null,
    event.originatingChannel ? `Originating channel: ${event.originatingChannel}` : null,
    event.originatingTo ? `Originating target: ${event.originatingTo}` : null,
    event.guildId ? `Guild: ${event.guildId}` : null,
    event.channelName ? `Channel name: ${event.channelName}` : null,
    event.groupId ? `Group: ${event.groupId}` : null,
    event.mediaType ? `Media type: ${event.mediaType}` : null,
    event.mediaPath ? `Media path: ${event.mediaPath}` : null,
    event.accessTag ? `Access tag: ${event.accessTag}` : null,
    typeof event.timestamp === "number"
      ? `Timestamp: ${new Date(event.timestamp).toISOString()}`
      : null,
    "",
    "## Content",
    contentText,
    pushBlock("Body", event.body),
    pushBlock("Body For Agent", event.bodyForAgent),
    pushBlock("Attachment Text", event.attachmentText),
    pushBlock("Transcript", event.transcript),
  ].filter((entry): entry is string => Boolean(entry));
  return `${lines.join("\n")}\n`;
}

function buildSessionDocBody(event: SessionQueueEvent): string {
  const lines = [
    "# Session message",
    event.sessionKey ? `Session: ${event.sessionKey}` : null,
    event.channelId ? `Channel: ${event.channelId}` : null,
    event.accountId ? `Account: ${event.accountId}` : null,
    event.conversationId ? `Conversation: ${event.conversationId}` : null,
    event.threadId ? `Thread: ${event.threadId}` : null,
    event.senderId ? `Sender: ${event.senderId}` : null,
    event.provider ? `Provider: ${event.provider}` : null,
    event.surface ? `Surface: ${event.surface}` : null,
    event.originatingChannel ? `Originating channel: ${event.originatingChannel}` : null,
    event.originatingTo ? `Originating target: ${event.originatingTo}` : null,
    event.groupId ? `Group: ${event.groupId}` : null,
    event.groupChannel ? `Group channel: ${event.groupChannel}` : null,
    event.groupSpace ? `Group space: ${event.groupSpace}` : null,
    event.subject ? `Subject: ${event.subject}` : null,
    event.chatType ? `Chat type: ${event.chatType}` : null,
    event.accessTag ? `Access tag: ${event.accessTag}` : null,
    event.role ? `Role: ${event.role}` : null,
    "",
    event.content,
  ].filter((entry): entry is string => Boolean(entry));
  return `${lines.join("\n")}\n`;
}

async function writeStoredDoc(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  event: QueueEvent;
  logger?: PluginLogger;
}): Promise<void> {
  const plugin = await resolveLangchainPluginConfig({
    cfg: params.cfg,
    logger: params.logger,
  });
  const source = params.event.kind === "session" ? "sessions" : params.event.source;
  const docId =
    params.event.kind === "session"
      ? makeStableId([
          source,
          params.event.agentId,
          params.event.sessionKey,
          params.event.role,
          params.event.content,
        ])
      : makeStableId([
          source,
          params.event.agentId,
          params.event.messageId,
          params.event.conversationId,
          params.event.timestamp,
          params.event.content,
        ]);
  const docsDir = path.join(plugin.documentsDir, params.event.agentId, source);
  const fileName = `${docId}.md`;
  const filePath = path.join(docsDir, fileName);
  const metaPath = path.join(docsDir, `${docId}.json`);
  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(
    filePath,
    params.event.kind === "session"
      ? buildSessionDocBody(params.event)
      : buildInboundDocBody(params.event),
    "utf-8",
  );
  const metadata =
    params.event.kind === "session"
      ? {
          source,
          path: path.posix.join("langchain", source, fileName),
          title: `session-${docId}`,
          sessionKey: params.event.sessionKey,
          channelId: params.event.channelId,
          accountId: params.event.accountId,
          conversationId: params.event.conversationId,
          threadId: params.event.threadId,
          senderId: params.event.senderId,
          provider: params.event.provider,
          surface: params.event.surface,
          originatingChannel: params.event.originatingChannel,
          originatingTo: params.event.originatingTo,
          groupId: params.event.groupId,
          channelName: params.event.groupChannel,
          groupSpace: params.event.groupSpace,
          accessTag: params.event.accessTag,
          role: params.event.role,
          chatType: params.event.chatType,
        }
      : {
          source,
          path: path.posix.join("langchain", source, fileName),
          title: `${source}-${docId}`,
          sessionKey: params.event.sessionKey,
          from: params.event.from,
          to: params.event.to,
          subject: params.event.subject,
          accessTag: params.event.accessTag,
          provider: params.event.provider,
          surface: params.event.surface,
          mimeType: params.event.mediaType,
          channelId: params.event.channelId,
          accountId: params.event.accountId,
          conversationId: params.event.conversationId,
          messageId: params.event.messageId,
          threadId: params.event.threadId,
          senderId: params.event.senderId,
          senderName: params.event.senderName,
          senderUsername: params.event.senderUsername,
          senderE164: params.event.senderE164,
          originatingChannel: params.event.originatingChannel,
          originatingTo: params.event.originatingTo,
          guildId: params.event.guildId,
          channelName: params.event.channelName,
          groupId: params.event.groupId,
          timestamp: params.event.timestamp,
          isGroup: params.event.isGroup === true,
        };
  await appendJson(metaPath, metadata);
}

export class LangchainMemoryRuntime {
  private interval: NodeJS.Timeout | null = null;
  private readonly touchedAgents = new Set<string>();
  private started = false;
  private drainInFlight = false;
  private drainRequested = false;
  private drainPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly logger?: PluginLogger) {}

  async start(params: { cfg: OpenClawConfig; workspaceDir: string }): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopping = false;
    const plugin = await resolveLangchainPluginConfig({
      cfg: params.cfg,
      logger: this.logger,
    });
    await fs.mkdir(plugin.pendingDir, { recursive: true });
    await fs.mkdir(plugin.documentsDir, { recursive: true });
    this.touchedAgents.add(resolveDefaultAgentId(params.cfg));
    this.requestDrain(params.cfg, params.workspaceDir);
    if (plugin.syncIntervalSec > 0) {
      this.interval = setInterval(() => {
        this.requestDrain(params.cfg, params.workspaceDir);
      }, plugin.syncIntervalSec * 1000);
      this.interval.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    await this.drainPromise?.catch(() => {});
    this.started = false;
  }

  private requestDrain(cfg: OpenClawConfig, workspaceDir: string) {
    if (this.stopping) {
      return;
    }
    void this.drainAndSync(cfg, workspaceDir).catch((error) => {
      this.logger?.warn?.(`memory-langchain: background drain failed: ${stringifyError(error)}`);
    });
  }

  async enqueueInbound(params: {
    cfg: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
    channelId: string;
    from?: string;
    to?: string;
    provider?: string;
    surface?: string;
    body?: string;
    bodyForAgent?: string;
    subject?: string;
    attachmentText?: string;
    transcript?: string;
    accountId?: string;
    conversationId?: string;
    messageId?: string;
    threadId?: string | number;
    senderId?: string;
    senderName?: string;
    senderUsername?: string;
    senderE164?: string;
    mediaPath?: string;
    mediaType?: string;
    originatingChannel?: string;
    originatingTo?: string;
    guildId?: string;
    channelName?: string;
    groupId?: string;
    timestamp?: number;
    isGroup?: boolean;
    content: string;
  }): Promise<void> {
    const content = normalizeText(params.content);
    if (!content) {
      return;
    }
    const agentId = deriveAgentId({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
    this.touchedAgents.add(agentId);
    const plugin = await resolveLangchainPluginConfig({
      cfg: params.cfg,
      logger: this.logger,
    });
    const event: InboundQueueEvent = {
      kind: "inbound",
      agentId,
      source: classifyInboundSource(params.channelId),
      sessionKey: normalizeText(params.sessionKey) || undefined,
      channelId: normalizeText(params.channelId) || "unknown",
      from: normalizeText(params.from) || undefined,
      to: normalizeText(params.to) || undefined,
      provider: normalizeText(params.provider) || undefined,
      surface: normalizeText(params.surface) || undefined,
      body: normalizeText(params.body) || undefined,
      bodyForAgent: normalizeText(params.bodyForAgent) || undefined,
      subject: normalizeText(params.subject) || undefined,
      attachmentText: normalizeText(params.attachmentText) || undefined,
      transcript: normalizeText(params.transcript) || undefined,
      accountId: normalizeText(params.accountId) || undefined,
      conversationId: normalizeText(params.conversationId) || undefined,
      messageId: normalizeText(params.messageId) || undefined,
      threadId:
        typeof params.threadId === "string" || typeof params.threadId === "number"
          ? String(params.threadId)
          : undefined,
      senderId: normalizeText(params.senderId) || undefined,
      senderName: normalizeText(params.senderName) || undefined,
      senderUsername: normalizeText(params.senderUsername) || undefined,
      senderE164: normalizeText(params.senderE164) || undefined,
      mediaPath: normalizeText(params.mediaPath) || undefined,
      mediaType: normalizeText(params.mediaType) || undefined,
      originatingChannel: normalizeText(params.originatingChannel) || undefined,
      originatingTo: normalizeText(params.originatingTo) || undefined,
      guildId: normalizeText(params.guildId) || undefined,
      channelName: normalizeText(params.channelName) || undefined,
      groupId: normalizeText(params.groupId) || undefined,
      timestamp: typeof params.timestamp === "number" ? params.timestamp : undefined,
      isGroup: params.isGroup === true,
      accessTag: deriveAccessTag({
        source: classifyInboundSource(params.channelId),
        sessionKey: params.sessionKey,
        channelId: params.channelId,
        accountId: params.accountId,
        conversationId: params.conversationId,
        isGroup: params.isGroup === true,
      }),
      content,
    };
    const filePath = path.join(
      plugin.pendingDir,
      `${event.agentId}-${makeStableId([event.source, event.messageId, event.conversationId, event.timestamp, event.content])}.json`,
    );
    await appendJson(filePath, event);
  }

  async enqueueSessionMessage(params: {
    cfg: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
    role?: string;
    message: unknown;
  }): Promise<void> {
    const agentId = deriveAgentId({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
    const content = extractTextFromMessage(params.message);
    if (!content) {
      return;
    }
    this.touchedAgents.add(agentId);
    const plugin = await resolveLangchainPluginConfig({
      cfg: params.cfg,
      logger: this.logger,
    });
    const sessionMetadata = resolveSessionMetadata(params.cfg, agentId, params.sessionKey);
    const event: SessionQueueEvent = {
      kind: "session",
      agentId,
      sessionKey: normalizeText(params.sessionKey) || undefined,
      ...sessionMetadata,
      accessTag: deriveAccessTag({
        source: "sessions",
        sessionKey: params.sessionKey,
        channelId: sessionMetadata.channelId,
        accountId: sessionMetadata.accountId,
        conversationId: sessionMetadata.conversationId,
        isGroup: sessionMetadata.chatType === "group" || sessionMetadata.chatType === "channel",
      }),
      role: normalizeText(params.role) || undefined,
      content,
    };
    const filePath = path.join(
      plugin.pendingDir,
      `${event.agentId}-${makeStableId([event.kind, event.sessionKey, event.role, event.content])}.json`,
    );
    await appendJson(filePath, event);
  }

  private async drainAndSyncOnce(cfg: OpenClawConfig, workspaceDir: string): Promise<void> {
    const plugin = await resolveLangchainPluginConfig({
      cfg,
      logger: this.logger,
    });
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(plugin.pendingDir))
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => path.join(plugin.pendingDir, entry))
        .toSorted();
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      try {
        const payload = JSON.parse(await fs.readFile(entry, "utf-8")) as QueueEvent;
        await writeStoredDoc({
          cfg,
          workspaceDir,
          event: payload,
          logger: this.logger,
        });
        this.touchedAgents.add(payload.agentId);
        await fs.rm(entry, { force: true });
      } catch (error) {
        const fileName = path.basename(entry);
        const attempt = readQueueRetryAttempt(fileName) + 1;
        const message = stringifyError(error);
        await appendLogEvent(plugin.logsPath, {
          type: "queue_item_failure",
          file: fileName,
          attempt,
          maxRetries: MAX_QUEUE_RETRIES,
          error: message,
          timestamp: Date.now(),
        }).catch(() => {});
        if (attempt >= MAX_QUEUE_RETRIES) {
          const failedDir = path.join(plugin.queueDir, "failed");
          await fs.mkdir(failedDir, { recursive: true });
          const deadLetterPath = path.join(
            failedDir,
            `${fileName.replace(/\.json$/i, "")}.failed-${Date.now()}.json`,
          );
          await fs
            .rename(entry, deadLetterPath)
            .catch(async () => {
              await fs.copyFile(entry, deadLetterPath);
              await fs.rm(entry, { force: true });
            })
            .catch(() => {});
          this.logger?.warn?.(
            `memory-langchain: queue item ${fileName} moved to failed after ${attempt} attempts: ${message}`,
          );
          continue;
        }
        const retryPath = buildRetryPath(entry, attempt);
        if (retryPath !== entry) {
          await fs
            .rename(entry, retryPath)
            .catch(async () => {
              await fs.copyFile(entry, retryPath);
              await fs.rm(entry, { force: true });
            })
            .catch(() => {});
        }
        this.logger?.warn?.(
          `memory-langchain: failed to process queue item ${fileName} (attempt ${attempt}/${MAX_QUEUE_RETRIES}): ${message}`,
        );
      }
    }
    const agents =
      this.touchedAgents.size > 0 ? Array.from(this.touchedAgents) : [resolveDefaultAgentId(cfg)];
    for (const agentId of agents) {
      try {
        const agentWorkspaceDir = resolveWorkspaceForAgent(cfg, agentId, workspaceDir);
        const manager = new LangchainMemoryManager(cfg, agentId, agentWorkspaceDir, this.logger);
        await manager.sync({ reason: "service" });
        this.touchedAgents.delete(agentId);
      } catch (error) {
        this.logger?.warn?.(`memory-langchain: sync failed for ${agentId}: ${String(error)}`);
      }
    }
  }

  async drainAndSync(cfg: OpenClawConfig, workspaceDir: string): Promise<void> {
    if (this.drainInFlight) {
      this.drainRequested = true;
      return this.drainPromise ?? Promise.resolve();
    }
    this.drainInFlight = true;
    this.drainPromise = (async () => {
      try {
        do {
          this.drainRequested = false;
          await this.drainAndSyncOnce(cfg, workspaceDir);
        } while (this.drainRequested && !this.stopping);
      } finally {
        this.drainInFlight = false;
        this.drainPromise = null;
      }
    })();
    return await this.drainPromise;
  }
}

function extractTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (typeof record.content === "string") {
    return record.content.trim();
  }
  if (Array.isArray(record.content)) {
    const text = record.content
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return "";
        }
        const block = entry as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") {
          return block.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return text.trim();
  }
  return "";
}

export function createLangchainMemoryRuntime(logger?: PluginLogger) {
  return new LangchainMemoryRuntime(logger);
}
